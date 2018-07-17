import {
  Request,
  RequestInit,
  Response,
  BodyInit,
  Headers,
  URL,
  URLSearchParams,
  URLSearchParamsInit,
} from 'apollo-server-env';

import { DataSource } from 'apollo-datasource';

import { KeyValueCache } from 'apollo-server-caching';
import { HTTPCache } from './HTTPCache';

import {
  ApolloError,
  AuthenticationError,
  ForbiddenError,
} from 'apollo-server-errors';

export type RequestOptions = RequestInit & {
  path: string;
  params: URLSearchParams;
  headers: Headers;
  body?: Body;
};

export type Body = BodyInit | object;
export { Request };

type ValueOrPromise<T> = T | Promise<T>;

export abstract class RESTDataSource<TContext = any> extends DataSource {
  httpCache!: HTTPCache;
  context!: TContext;

  initialize(context: TContext, cache: KeyValueCache): void {
    this.context = context;
    this.httpCache = new HTTPCache(cache);
  }

  baseURL?: string;

  // By default, we use the full request URL as the cache key.
  // You can override this to remove query parameters or compute a cache key in any way that makes sense.
  // For example, you could use this to take Vary header fields into account.
  // Although we do validate header fields and don't serve responses from cache when they don't match,
  // new reponses overwrite old ones with different vary header fields.
  protected cacheKeyFor(request: Request): string {
    return request.url;
  }

  protected willSendRequest?(request: RequestOptions): ValueOrPromise<void>;

  protected resolveURL(request: RequestOptions): ValueOrPromise<URL> {
    const baseURL = this.baseURL;
    if (baseURL) {
      const normalizedBaseURL = baseURL.endsWith('/')
        ? baseURL
        : baseURL.concat('/');
      return new URL(request.path, normalizedBaseURL);
    } else {
      return new URL(request.path);
    }
  }

  protected async didReceiveResponse<TResult = any>(
    response: Response,
    _request: Request,
  ): Promise<TResult> {
    if (response.ok) {
      return (this.parseBody(response) as any) as Promise<TResult>;
    } else {
      throw await this.errorFromResponse(response);
    }
  }

  protected didEncounterError(error: Error, _request: Request) {
    throw error;
  }

  protected parseBody(response: Response): Promise<object | string> {
    const contentType = response.headers.get('Content-Type');
    if (contentType && contentType.startsWith('application/json')) {
      return response.json();
    } else {
      return response.text();
    }
  }

  protected async errorFromResponse(response: Response) {
    const message = `${response.status}: ${response.statusText}`;

    let error: ApolloError;
    if (response.status === 401) {
      error = new AuthenticationError(message);
    } else if (response.status === 403) {
      error = new ForbiddenError(message);
    } else {
      error = new ApolloError(message);
    }

    const body = await this.parseBody(response);

    Object.assign(error.extensions, {
      response: {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        body,
      },
    });

    return error;
  }

  protected async get<TResult = any>(
    path: string,
    params?: URLSearchParamsInit,
    init?: RequestInit,
  ): Promise<TResult> {
    return this.fetch<TResult>(
      Object.assign({ method: 'GET', path, params }, init),
    );
  }

  protected async post<TResult = any>(
    path: string,
    body?: Body,
    init?: RequestInit,
  ): Promise<TResult> {
    return this.fetch<TResult>(
      Object.assign({ method: 'POST', path, body }, init),
    );
  }

  protected async patch<TResult = any>(
    path: string,
    body?: Body,
    init?: RequestInit,
  ): Promise<TResult> {
    return this.fetch<TResult>(
      Object.assign({ method: 'PATCH', path, body }, init),
    );
  }

  protected async put<TResult = any>(
    path: string,
    body?: Body,
    init?: RequestInit,
  ): Promise<TResult> {
    return this.fetch<TResult>(
      Object.assign({ method: 'PUT', path, body }, init),
    );
  }

  protected async delete<TResult = any>(
    path: string,
    params?: URLSearchParamsInit,
    init?: RequestInit,
  ): Promise<TResult> {
    return this.fetch<TResult>(
      Object.assign({ method: 'DELETE', path, params }, init),
    );
  }

  private async fetch<TResult>(
    init: RequestInit & {
      path: string;
      params?: URLSearchParamsInit;
    },
  ): Promise<TResult> {
    if (!(init.params instanceof URLSearchParams)) {
      init.params = new URLSearchParams(init.params);
    }

    if (!(init.headers && init.headers instanceof Headers)) {
      init.headers = new Headers(init.headers);
    }

    const options = init as RequestOptions;

    if (this.willSendRequest) {
      await this.willSendRequest(options);
    }

    const url = await this.resolveURL(options);

    // Append params to existing params in the path
    for (const [name, value] of options.params) {
      url.searchParams.append(name, value);
    }

    // We accept arbitrary objects as body and serialize them as JSON
    if (
      options.body !== undefined &&
      options.body !== null &&
      (options.body.constructor === Object ||
        ((options.body as any).toJSON &&
          typeof (options.body as any).toJSON === 'function'))
    ) {
      options.body = JSON.stringify(options.body);
      options.headers.set('Content-Type', 'application/json');
    }

    const request = new Request(String(url), options);

    const cacheKey = this.cacheKeyFor(request);

    return this.trace(`${options.method || 'GET'} ${url}`, async () => {
      try {
        const response = await this.httpCache.fetch(request, { cacheKey });
        return this.didReceiveResponse(response, request);
      } catch (error) {
        this.didEncounterError(error, request);
      }
    });
  }

  private async trace<TResult>(
    label: string,
    fn: () => Promise<TResult>,
  ): Promise<TResult> {
    if (process && process.env && process.env.NODE_ENV === 'development') {
      // We're not using console.time because that isn't supported on Cloudflare
      const startTime = Date.now();
      try {
        return await fn();
      } finally {
        const duration = Date.now() - startTime;
        console.log(`${label} (${duration}ms)`);
      }
    } else {
      return fn();
    }
  }
}
