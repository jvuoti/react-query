import { difference, notNullOrUndefined, replaceAt } from './utils'
import { notifyManager } from './notifyManager'
import type { QueryObserverOptions, QueryObserverResult } from './types'
import type { QueryClient } from './queryClient'
import { NotifyOptions, QueryObserver } from './queryObserver'
import { Subscribable } from './subscribable'

type QueriesObserverListener = (result: QueryObserverResult[]) => void

export class QueriesObserver extends Subscribable<QueriesObserverListener> {
  private client: QueryClient
  private result: QueryObserverResult[]
  private queries: QueryObserverOptions[]
  private observers: QueryObserver[]
  private observersMap: Record<string, QueryObserver>

  constructor(client: QueryClient, queries?: QueryObserverOptions[]) {
    super()

    this.client = client
    this.queries = []
    this.result = []
    this.observers = []
    this.observersMap = {}

    if (queries) {
      this.setQueries(queries)
    }
  }

  protected onSubscribe(): void {
    if (this.listeners.length === 1) {
      this.observers.forEach(observer => {
        observer.subscribe(result => {
          this.onUpdate(observer, result)
        })
      })
    }
  }

  protected onUnsubscribe(): void {
    if (!this.listeners.length) {
      this.destroy()
    }
  }

  destroy(): void {
    this.listeners = []
    this.observers.forEach(observer => {
      observer.destroy()
    })
  }

  setQueries(
    queries: QueryObserverOptions[],
    notifyOptions?: NotifyOptions
  ): void {
    this.queries = queries
    this.updateObservers(notifyOptions)
  }

  getCurrentResult(): QueryObserverResult[] {
    return this.result
  }

  getOptimisticResult(queries: QueryObserverOptions[]): QueryObserverResult[] {
    return this.getUpdatedObservers(queries).newResult
  }

  private getUpdatedObservers(
    queries: QueryObserverOptions[],
    notifyOptions?: NotifyOptions
  ): QueryObserverUpdate {
    const prevObservers = this.observers
    const prevObserversMap = this.observersMap
    const newResult: QueryObserverResult[] = []
    const newObservers: QueryObserver[] = []
    const newObserversMap: Record<string, QueryObserver> = {}

    const defaultedQueryOptions = queries.map(o =>
      this.client.defaultQueryObserverOptions(o)
    )
    const matchingObservers = defaultedQueryOptions
      .map(o => {
        if (o.queryHash == null) {
          return null
        }
        const match = prevObserversMap[o.queryHash]
        if (match != null) {
          match.setOptions(o, notifyOptions)
          return match
        }
        return null
      })
      .filter(notNullOrUndefined)

    const matchedQueryHashes = matchingObservers
      .map(o => o?.options.queryHash)
      .filter(notNullOrUndefined)
    const unmatchedQueries = defaultedQueryOptions.filter(
      o =>
        o.queryHash !== undefined && !matchedQueryHashes.includes(o.queryHash)
    )

    const unmatchedObservers = prevObservers.filter(
      p => !matchingObservers.includes(p)
    )

    const newlyMatchedOrCreatedObservers = unmatchedQueries.map(q => {
      if (q.keepPreviousData && unmatchedObservers.length > 0) {
        // use the first existing but no longer matched query to keep query data for any new queries
        const firstObserver = unmatchedObservers.splice(0, 1)[0]
        if (firstObserver !== undefined) {
          firstObserver.setOptions(q, notifyOptions)
          return firstObserver
        }
      }
      return this.getObserver(q)
    })

    matchingObservers
      .concat(newlyMatchedOrCreatedObservers)
      .forEach(observer => {
        newObservers.push(observer)
        newResult.push(observer.getCurrentResult())
        newObserversMap[observer.options.queryHash!] = observer
      })

    return {
      newResult: newResult,
      newObservers: newObservers,
      newObserversMap: newObserversMap,
    }
  }

  private getObserver(options: QueryObserverOptions): QueryObserver {
    const defaultedOptions = this.client.defaultQueryObserverOptions(options)
    const currentObserver = this.observersMap[defaultedOptions.queryHash!]
    return currentObserver ?? new QueryObserver(this.client, defaultedOptions)
  }

  private updateObservers(notifyOptions?: NotifyOptions): void {
    notifyManager.batch(() => {
      const prevObservers = this.observers
      const updatedObservers = this.getUpdatedObservers(
        this.queries,
        notifyOptions
      )

      const hasIndexChange = updatedObservers.newObservers.some(
        (o, i) => o !== prevObservers[i]
      )
      if (
        prevObservers.length === updatedObservers.newObservers.length &&
        !hasIndexChange
      ) {
        return
      }

      this.observers = updatedObservers.newObservers
      this.observersMap = updatedObservers.newObserversMap
      this.result = updatedObservers.newResult

      if (!this.hasListeners()) {
        return
      }

      difference(prevObservers, updatedObservers.newObservers).forEach(
        observer => {
          observer.destroy()
        }
      )

      difference(updatedObservers.newObservers, prevObservers).forEach(
        observer => {
          observer.subscribe(result => {
            this.onUpdate(observer, result)
          })
        }
      )

      this.notify()
    })
  }

  private onUpdate(observer: QueryObserver, result: QueryObserverResult): void {
    const index = this.observers.indexOf(observer)
    if (index !== -1) {
      this.result = replaceAt(this.result, index, result)
      this.notify()
    }
  }

  private notify(): void {
    notifyManager.batch(() => {
      this.listeners.forEach(listener => {
        listener(this.result)
      })
    })
  }
}

type QueryObserverUpdate = {
  newResult: QueryObserverResult[]
  newObservers: QueryObserver[]
  newObserversMap: Record<string, QueryObserver>
}
