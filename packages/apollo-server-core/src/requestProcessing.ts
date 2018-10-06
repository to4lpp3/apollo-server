import {
  GraphQLSchema,
  GraphQLFieldResolver,
  ValidationContext,
  ASTVisitor,
  DocumentNode,
  parse,
  specifiedRules,
  validate,
  GraphQLError,
  ExecutionArgs,
  ExecutionResult,
  execute,
  getOperationAST,
  OperationDefinitionNode,
} from 'graphql';
import {
  GraphQLExtension,
  GraphQLExtensionStack,
  enableGraphQLExtensions,
} from 'graphql-extensions';
import { KeyValueCache } from 'apollo-server-caching';
import { DataSource } from 'apollo-datasource';
import { PersistedQueryOptions } from './';
import {
  CacheControlExtension,
  CacheControlExtensionOptions,
} from 'apollo-cache-control';
import { TracingExtension } from 'apollo-tracing';
import {
  fromGraphQLError,
  SyntaxError,
  ValidationError,
  PersistedQueryNotSupportedError,
  PersistedQueryNotFoundError,
} from 'apollo-server-errors';
import { createHash } from 'crypto';

import { GraphQLRequest } from './requestPipelineAPI';
export { GraphQLRequest };

export interface GraphQLResponse {
  data?: object;
  errors?: GraphQLError[];
  extensions?: Record<string, any>;
}

export interface GraphQLRequestOptions<TContext> {
  schema: GraphQLSchema;

  rootValue?: ((parsedQuery: DocumentNode) => any) | any;

  context: TContext;

  cache: KeyValueCache;
  dataSources?: () => DataSources<TContext>;

  validationRules?: ValidationRule[];
  fieldResolver?: GraphQLFieldResolver<any, TContext>;

  debug?: boolean;

  extensions?: Array<() => GraphQLExtension>;
  tracing?: boolean;
  persistedQueries?: PersistedQueryOptions;
  cacheControl?: CacheControlExtensionOptions;

  formatError?: Function;
  formatResponse?: Function;
}

export type DataSources<TContext> = {
  [name: string]: DataSource<TContext>;
};

export type ValidationRule = (context: ValidationContext) => ASTVisitor;

export class InvalidGraphQLRequestError extends Error {}

export interface GraphQLRequestProcessor<TContext> {
  willExecuteOperation?(operation: OperationDefinitionNode): void;
}

export class GraphQLRequestProcessor<TContext> {
  context: TContext;

  extensionStack!: GraphQLExtensionStack;
  cacheControlExtension?: CacheControlExtension;

  constructor(private options: GraphQLRequestOptions<TContext>) {
    this.context = this.initializeContext();
    this.initializeExtensions();
  }

  initializeContext() {
    // FIXME: We currently shallow clone the context for every request,
    // but that's unlikely to be what people want.
    // The problem here is that even if you pass in a function for `context`,
    // this only runs once for a batched request
    // (in ApolloServer#graphQLServerOptions).
    const context = cloneObject(this.options.context);

    if (this.options.dataSources) {
      const dataSources = this.options.dataSources();

      for (const dataSource of Object.values(dataSources)) {
        if (dataSource.initialize) {
          dataSource.initialize({
            context: this.context,
            cache: this.options.cache,
          });
        }
      }

      if ('dataSources' in context) {
        throw new Error(
          'Please use the dataSources config option instead of putting dataSources on the context yourself.',
        );
      }

      (context as any).dataSources = dataSources;
    }

    return context;
  }

  initializeExtensions() {
    // If custom extension factories were provided, create per-request extension
    // objects.
    const extensions = this.options.extensions
      ? this.options.extensions.map(f => f())
      : [];

    // If you're running behind an engineproxy, set these options to turn on
    // tracing and cache-control extensions.
    if (this.options.tracing) {
      extensions.push(new TracingExtension());
    }

    if (this.options.cacheControl) {
      this.cacheControlExtension = new CacheControlExtension(
        this.options.cacheControl,
      );
      extensions.push(this.cacheControlExtension);
    }

    this.extensionStack = new GraphQLExtensionStack(extensions);

    // We unconditionally create an extensionStack, even if there are no
    // extensions (so that we don't have to litter the rest of this function with
    // `if (extensionStack)`, but we don't instrument the schema unless there
    // actually are extensions.  We do unconditionally put the stack on the
    // context, because if some other call had extensions and the schema is
    // already instrumented, that's the only way to get a custom fieldResolver to
    // work.
    if (extensions.length > 0) {
      enableGraphQLExtensions(this.options.schema);
    }
    (this.context as any)._extensionStack = this.extensionStack;
  }

  async processRequest(request: GraphQLRequest): Promise<GraphQLResponse> {
    let { query, extensions } = request;

    let persistedQueryHit = false;
    let persistedQueryRegister = false;

    if (extensions && extensions.persistedQuery) {
      // It looks like we've received an Apollo Persisted Query. Check if we
      // support them. In an ideal world, we always would, however since the
      // middleware options are created every request, it does not make sense
      // to create a default cache here and save a referrence to use across
      // requests
      if (
        !this.options.persistedQueries ||
        !this.options.persistedQueries.cache
      ) {
        throw new PersistedQueryNotSupportedError();
      } else if (extensions.persistedQuery.version !== 1) {
        throw new InvalidGraphQLRequestError(
          'Unsupported persisted query version',
        );
      }

      const sha = extensions.persistedQuery.sha256Hash;

      if (query === undefined) {
        query =
          (await this.options.persistedQueries.cache.get(`apq:${sha}`)) ||
          undefined;
        if (query) {
          persistedQueryHit = true;
        } else {
          throw new PersistedQueryNotFoundError();
        }
      } else {
        const hash = createHash('sha256');
        const calculatedSha = hash.update(query).digest('hex');

        if (sha !== calculatedSha) {
          throw new InvalidGraphQLRequestError(
            'provided sha does not match query',
          );
        }
        persistedQueryRegister = true;

        // Do the store completely asynchronously
        (async () => {
          // We do not wait on the cache storage to complete
          return (
            this.options.persistedQueries &&
            this.options.persistedQueries.cache.set(`apq:${sha}`, query)
          );
        })().catch(error => {
          console.warn(error);
        });
      }
    }

    if (!query) {
      throw new InvalidGraphQLRequestError('Must provide query string.');
    }

    const requestDidEnd = this.extensionStack.requestDidStart({
      request: request.httpRequest!,
      queryString: request.query,
      operationName: request.operationName,
      variables: request.variables,
      extensions: request.extensions,
      persistedQueryHit,
      persistedQueryRegister,
    });

    try {
      let document: DocumentNode;
      try {
        document = this.parse(query);
      } catch (syntaxError) {
        return this.willSendResponse({
          errors: [
            fromGraphQLError(syntaxError, {
              errorClass: SyntaxError,
            }),
          ],
        });
      }

      const validationErrors = this.validate(document);

      if (validationErrors.length > 0) {
        return this.willSendResponse({
          errors: validationErrors.map(validationError =>
            fromGraphQLError(validationError, {
              errorClass: ValidationError,
            }),
          ),
        });
      }

      const operation = getOperationAST(document, request.operationName);
      // If we don't find an operation, we'll leave it to `buildExecutionContext`
      // to throw an appropriate error.
      if (operation && this.willExecuteOperation) {
        this.willExecuteOperation(operation);
      }

      let response: GraphQLResponse;

      try {
        response = (await this.execute(
          document,
          request.operationName,
          request.variables,
        )) as GraphQLResponse;
      } catch (executionError) {
        return this.willSendResponse({
          errors: [fromGraphQLError(executionError)],
        });
      }

      const formattedExtensions = this.extensionStack.format();
      if (Object.keys(formattedExtensions).length > 0) {
        response.extensions = formattedExtensions;
      }

      if (this.options.formatResponse) {
        response = this.options.formatResponse(response, {
          context: this.context,
        });
      }

      return this.willSendResponse(response);
    } finally {
      requestDidEnd();
    }
  }

  private willSendResponse(response: GraphQLResponse): GraphQLResponse {
    return this.extensionStack.willSendResponse({
      graphqlResponse: response,
    }).graphqlResponse;
  }

  parse(query: string): DocumentNode {
    const parsingDidEnd = this.extensionStack.parsingDidStart({
      queryString: query,
    });

    try {
      return parse(query);
    } finally {
      parsingDidEnd();
    }
  }

  validate(document: DocumentNode): ReadonlyArray<GraphQLError> {
    let rules = specifiedRules;
    if (this.options.validationRules) {
      rules = rules.concat(this.options.validationRules);
    }

    const validationDidEnd = this.extensionStack.validationDidStart();

    try {
      return validate(this.options.schema, document, rules);
    } finally {
      validationDidEnd();
    }
  }

  async execute(
    document: DocumentNode,
    operationName: GraphQLRequest['operationName'],
    variables: GraphQLRequest['variables'],
  ): Promise<ExecutionResult> {
    const executionArgs: ExecutionArgs = {
      schema: this.options.schema,
      document,
      rootValue:
        typeof this.options.rootValue === 'function'
          ? this.options.rootValue(document)
          : this.options.rootValue,
      contextValue: this.context,
      variableValues: variables,
      operationName,
      fieldResolver: this.options.fieldResolver,
    };

    const executionDidEnd = this.extensionStack.executionDidStart({
      executionArgs,
    });

    try {
      return execute(executionArgs);
    } finally {
      executionDidEnd();
    }
  }
}

function cloneObject<T extends Object>(object: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(object)), object);
}
