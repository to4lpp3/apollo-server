import { HTTPCache } from './HTTPCache';

export abstract class RESTDataSource<TContext = any> {
  abstract baseURL: string;

  httpCache!: HTTPCache;
  context!: TContext;

  public willSendRequest?(request: Request): void;

  protected async get<TResponse = any>(
    path: string,
    params?: URLSearchParamsInit,
    options?: RequestInit,
  ): Promise<TResponse> {
    return this.fetch<TResponse>(
      path,
      params,
      Object.assign({ method: 'GET' }, options),
    );
  }

  protected async post<TResponse = any>(
    path: string,
    params?: URLSearchParamsInit,
    options?: RequestInit,
  ): Promise<TResponse> {
    return this.fetch<TResponse>(
      path,
      params,
      Object.assign({ method: 'POST' }, options),
    );
  }

  protected async patch<TResponse = any>(
    path: string,
    params?: URLSearchParamsInit,
    options?: RequestInit,
  ): Promise<TResponse> {
    return this.fetch<TResponse>(
      path,
      params,
      Object.assign({ method: 'PATCH' }, options),
    );
  }

  protected async put<TResponse = any>(
    path: string,
    params?: URLSearchParamsInit,
    options?: RequestInit,
  ): Promise<TResponse> {
    return this.fetch<TResponse>(
      path,
      params,
      Object.assign({ method: 'PUT' }, options),
    );
  }

  protected async delete<TResponse = any>(
    path: string,
    params?: URLSearchParamsInit,
    options?: RequestInit,
  ): Promise<TResponse> {
    return this.fetch<TResponse>(
      path,
      params,
      Object.assign({ method: 'DELETE' }, options),
    );
  }

  private async fetch<TResponse>(
    path: string,
    params?: URLSearchParamsInit,
    init?: RequestInit,
  ): Promise<TResponse> {
    const url = new URL(path, this.baseURL);

    if (params) {
      // Append params to existing params in the path
      for (const [name, value] of new URLSearchParams(params)) {
        url.searchParams.append(name, value);
      }
    }

    return this.trace(`${(init && init.method) || 'GET'} ${url}`, async () => {
      const request = new Request(String(url));

      if (this.willSendRequest) {
        this.willSendRequest(request);
      }

      const response = await this.httpCache.fetch(request, init);
      if (response.ok) {
        const contentType = response.headers.get('Content-Type');

        if (contentType && contentType.startsWith('application/json')) {
          return response.json();
        } else {
          return response.text();
        }
      } else {
        throw new Error(
          `${response.status} ${response.statusText}: ${await response.text()}`,
        );
      }
    });
  }

  private async trace<Result>(
    label: string,
    fn: () => Promise<Result>,
  ): Promise<Result> {
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
