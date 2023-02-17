const { assertionMetadata, formatAssertion, calculateRoot } = require('assertion-tools');
const jsonld = require('jsonld');
const {
    isEmptyObject,
    deriveUAL,
    getOperationStatusObject,
    resolveUAL,
    toNQuads,
} = require('../services/utilities.js');
const {
    ASSERTION_STATES,
    CONTENT_TYPES,
    OPERATIONS,
    OPERATIONS_STEP_STATUS,
    GET_OUTPUT_FORMATS,
    OPERATION_STATUSES,
    DEFAULT_GET_LOCAL_STORE_RESULT_FREQUENCY,
    PRIVATE_ASSERTION_PREDICATE,
    QUERY_TYPES,
} = require('../constants.js');
const emptyHooks = require('../util/empty-hooks');

class AssetOperationsManager {
    constructor(config, services) {
        this.nodeApiService = services.nodeApiService;
        this.validationService = services.validationService;
        this.blockchainService = services.blockchainService;
        this.inputService = services.inputService;
    }

    async create(content, options = {}, stepHooks = emptyHooks) {
        this.validationService.validateObjectType(content);
        let jsonContent = {};

        // for backwards compatibility
        if (!content.public && !content.private) {
            jsonContent.public = content;
        } else {
            jsonContent = content;
        }

        const {
            blockchain,
            endpoint,
            port,
            maxNumberOfRetries,
            frequency,
            epochsNum,
            hashFunctionId,
            scoreFunctionId,
            immutable,
            tokenAmount,
            authToken,
        } = this.inputService.getAssetCreateArguments(options);

        this.validationService.validateAssetCreate(
            jsonContent,
            blockchain,
            endpoint,
            port,
            maxNumberOfRetries,
            frequency,
            epochsNum,
            hashFunctionId,
            scoreFunctionId,
            immutable,
            tokenAmount,
            authToken,
        );

        let privateAssertion;
        let privateAssertionId;
        if (jsonContent.private && !isEmptyObject(jsonContent.private)) {
            privateAssertion = await formatAssertion(jsonContent.private);
            privateAssertionId = calculateRoot(privateAssertion);
        }
        const publicGraph = {
            '@graph': [
                jsonContent.public && !isEmptyObject(jsonContent.public)
                    ? jsonContent.public
                    : null,
                jsonContent.private && !isEmptyObject(jsonContent.private)
                    ? {
                          [PRIVATE_ASSERTION_PREDICATE]: privateAssertionId,
                      }
                    : null,
            ],
        };
        const publicAssertion = await formatAssertion(publicGraph);
        const publicAssertionId = calculateRoot(publicAssertion);

        const contentAssetStorageAddress = await this.blockchainService.getContractAddress(
            'ContentAssetStorage',
            blockchain,
        );

        const tokenAmountInWei =
            tokenAmount ??
            (await this.nodeApiService.getBidSuggestion(
                endpoint,
                port,
                authToken,
                blockchain.name.startsWith('otp') ? 'otp' : blockchain.name,
                epochsNum,
                assertionMetadata.getAssertionSizeInBytes(publicAssertion),
                contentAssetStorageAddress,
                publicAssertionId,
                hashFunctionId,
            ));

        const tokenId = await this.blockchainService.createAsset(
            {
                publicAssertionId,
                assertionSize: assertionMetadata.getAssertionSizeInBytes(publicAssertion),
                triplesNumber: assertionMetadata.getAssertionTriplesNumber(publicAssertion),
                chunksNumber: assertionMetadata.getAssertionChunksNumber(publicAssertion),
                epochsNum,
                tokenAmount: tokenAmountInWei,
                scoreFunctionId: scoreFunctionId ?? 1,
                immutable_: immutable,
            },
            blockchain,
            stepHooks,
        );

        const resolvedUAL = {
            blockchain: blockchain.name,
            contract: contentAssetStorageAddress,
            tokenId,
        };
        const assertions = [
            {
                ...resolvedUAL,
                assertionId: publicAssertionId,
                assertion: publicAssertion,
            },
        ];
        if (privateAssertion?.length) {
            assertions.push({
                ...resolvedUAL,
                assertionId: privateAssertionId,
                assertion: privateAssertion,
            });
        }
        let operationId = await this.nodeApiService.localStore(
            endpoint,
            port,
            authToken,
            assertions,
        );
        let operationResult = await this.nodeApiService.getOperationResult(
            endpoint,
            port,
            authToken,
            OPERATIONS.LOCAL_STORE,
            maxNumberOfRetries,
            DEFAULT_GET_LOCAL_STORE_RESULT_FREQUENCY,
            operationId,
        );

        const UAL = deriveUAL(blockchain.name, contentAssetStorageAddress, tokenId);

        if (operationResult.status === OPERATION_STATUSES.FAILED) {
            return {
                UAL,
                assertionId: publicAssertionId,
                operation: getOperationStatusObject(operationResult, operationId),
            };
        }

        operationId = await this.nodeApiService.publish(
            endpoint,
            port,
            authToken,
            publicAssertionId,
            publicAssertion,
            blockchain.name,
            contentAssetStorageAddress,
            tokenId,
            hashFunctionId,
        );

        operationResult = await this.nodeApiService.getOperationResult(
            endpoint,
            port,
            authToken,
            OPERATIONS.PUBLISH,
            maxNumberOfRetries,
            frequency,
            operationId,
        );

        stepHooks.afterHook({
            status: OPERATIONS_STEP_STATUS.CREATE_ASSET_COMPLETED,
            data: {
                operationId,
                operationResult,
            },
        });

        return {
            UAL,
            publicAssertionId,
            operation: getOperationStatusObject(operationResult, operationId),
        };
    }

    async get(UAL, options = {}) {
        const {
            blockchain,
            endpoint,
            port,
            maxNumberOfRetries,
            frequency,
            state,
            contentType,
            validate,
            outputFormat,
            authToken,
            hashFunctionId,
        } = this.inputService.getAssetGetArguments(options);

        this.validationService.validateAssetGet(
            UAL,
            blockchain,
            endpoint,
            port,
            maxNumberOfRetries,
            frequency,
            state,
            contentType,
            hashFunctionId,
            validate,
            outputFormat,
            authToken,
        );

        const contentObj = {};
        contentObj.operation = {};

        const { tokenId } = resolveUAL(UAL);

        let publicAssertionId;
        let getPublicOperationId;
        if (state === ASSERTION_STATES.LATEST) {
            publicAssertionId = await this.blockchainService.getLatestAssertionId(
                tokenId,
                blockchain,
            );

            getPublicOperationId = await this.nodeApiService.get(
                endpoint,
                port,
                authToken,
                UAL,
                hashFunctionId,
            );
        }

        let getPublicOperationResult = await this.nodeApiService.getOperationResult(
            endpoint,
            port,
            authToken,
            OPERATIONS.GET,
            maxNumberOfRetries,
            frequency,
            getPublicOperationId,
        );

        let publicAssertion = getPublicOperationResult.data.assertion;

        if (validate === true && calculateRoot(publicAssertion) !== publicAssertionId) {
            throw Error("Calculated root hashes don't match!");
        }

        if (contentType !== CONTENT_TYPES.PRIVATE) {
            try {
                if (outputFormat !== GET_OUTPUT_FORMATS.N_QUADS) {
                    publicAssertion = await jsonld.fromRDF(publicAssertion.join('\n'), {
                        algorithm: 'URDNA2015',
                        format: 'application/n-quads',
                    });
                } else {
                    publicAssertion = publicAssertion.join('\n');
                }
            } catch (error) {
                getPublicOperationResult = {
                    ...getPublicOperationResult,
                    data: {
                        errorType: 'DKG_CLIENT_ERROR',
                        errorMessage: error.message,
                    },
                };
            }

            contentObj.public = publicAssertion;
            contentObj.publicAssertionId = publicAssertionId;
            contentObj.operation.publicGet = getOperationStatusObject(
                getPublicOperationResult,
                getPublicOperationId,
            );
        }

        if (contentType !== CONTENT_TYPES.PUBLIC) {
            const privateAssertionLinkTriple = publicAssertion.filter((element) =>
                element.includes(PRIVATE_ASSERTION_PREDICATE),
            )[0];

            if (privateAssertionLinkTriple) {
                const regex = /"(.*?)"/;
                const privateAssertionId = privateAssertionLinkTriple.match(regex)[1];

                const queryString = `
                    CONSTRUCT { ?s ?p ?o }
                    WHERE {
                        {
                            GRAPH <assertion:${privateAssertionId}>
                            {
                                ?s ?p ?o .
                            }
                        }
                    }`;

                const queryPrivateOperationId = await this.nodeApiService.query(
                    endpoint,
                    port,
                    authToken,
                    queryString,
                    QUERY_TYPES.CONSTRUCT,
                );

                let queryPrivateOperationResult = await this.nodeApiService.getOperationResult(
                    endpoint,
                    port,
                    authToken,
                    OPERATIONS.QUERY,
                    maxNumberOfRetries,
                    frequency,
                    queryPrivateOperationId,
                );

                const privateAssertionNQuads = queryPrivateOperationResult.data;

                let privateAssertion = await toNQuads(privateAssertionNQuads, 'application/n-quads');

                if (validate === true && calculateRoot(privateAssertion) !== privateAssertionId) {
                    throw Error("Calculated root hashes don't match!");
                }

                try {
                    if (outputFormat !== GET_OUTPUT_FORMATS.N_QUADS) {
                        privateAssertion = await jsonld.fromRDF(privateAssertion.join('\n'), {
                            algorithm: 'URDNA2015',
                            format: 'application/n-quads',
                        });
                    } else {
                        privateAssertion = privateAssertion.join('\n');
                    }
                } catch (error) {
                    queryPrivateOperationResult = {
                        ...queryPrivateOperationResult,
                        data: {
                            errorType: 'DKG_CLIENT_ERROR',
                            errorMessage: error.message,
                        },
                    };
                }

                contentObj.private = privateAssertion;
                contentObj.privateAssertionId = privateAssertionId;
                contentObj.operation.queryPrivate = getOperationStatusObject(
                    queryPrivateOperationResult,
                    queryPrivateOperationId,
                );
            } else if (contentType === CONTENT_TYPES.PRIVATE) {
                contentObj.operation.queryPrivate = {
                    data: {
                        errorType: 'DKG_CLIENT_ERROR',
                        errorMessage: `Node doesn't have private data of ${UAL}`,
                    },
                };
            }
        }

        return contentObj;
    }

    /* async update(UAL, content, opts = {}) {
    const options = JSON.parse(JSON.stringify(opts));
    this.validationService.validatePublishRequest(content, options);
    const assertion = await formatAssertion(content);
    const assertionId = calculateRoot(assertion);
    const endpoint = this.getEndpoint(options);
        const port = this.getPort(options);
    const tokenAmount =
      options.tokenAmount ??
      (await this.nodeApiService.getBidSuggestion(
        endpoint,
        port,
        options.blockchain.name,
        options.epochsNum,
        assertionMetadata.getAssertionSizeInBytes(assertion),
        options.hashFunctionId ?? DEFAULT_HASH_FUNCTION_ID,
      ));
    await this.blockchainService.updateAsset(
      Utilities.resolveUAL(UAL).tokenId,
      {
        assertionId,
        assertionSize: assertionMetadata.getAssertionSizeInBytes(assertion),
        triplesNumber: assertionMetadata.getAssertionTriplesNumber(assertion),
        chunksNumber: assertionMetadata.getAssertionChunksNumber(assertion),
        epochsNum: options.epochsNum,
        tokenAmount: tokenAmount,
        scoreFunctionId: options.scoreFunctionId ?? 1,
      },
      blockchain
    );
    let operationId = await this.nodeApiService.publish(
        endpoint,
        port,
      assertionId,
      assertion,
      UAL,
      hashFunctionId
    );
    let operationResult = await this.nodeApiService.getOperationResult(
      operationId,
      { ...options, operation: OPERATIONS.PUBLISH }
    );
    return {
      UAL,
      assertionId,
      operation: Utilities.getOperationStatusObject(
        operationResult,
        operationId
      ),
    };
  } */

    async transfer(UAL, newOwner, options = {}) {
        const blockchain = await this.inputService.getBlockchain(options);

        this.validationService.validateAssetTransfer(UAL, newOwner, blockchain);

        const { tokenId } = resolveUAL(UAL);
        await this.blockchainService.transferAsset(tokenId, newOwner, blockchain);
        const owner = await this.blockchainService.getAssetOwner(tokenId, blockchain);
        return {
            UAL,
            owner,
            operation: getOperationStatusObject({ status: 'COMPLETED' }, null),
        };
    }

    async getOwner(UAL, options = {}) {
        const blockchain = await this.inputService.getBlockchain(options);

        this.validationService.validateAssetGetOwner(UAL, blockchain);

        const { tokenId } = resolveUAL(UAL);
        const owner = await this.blockchainService.getAssetOwner(tokenId, blockchain);
        return {
            UAL,
            owner,
            operation: getOperationStatusObject({ data: {}, status: 'COMPLETED' }, null),
        };
    }
}
module.exports = AssetOperationsManager;
