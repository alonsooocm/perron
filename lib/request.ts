import { IncomingHttpHeaders, IncomingMessage, request as httpRequest } from 'http'
import { request as httpsRequest, RequestOptions } from 'https'
import * as zlib from 'zlib'
import * as querystring from 'querystring'

const getInterval = (time: [number, number]): number => {
  const diff = process.hrtime(time)
  return Math.round((diff[0] * 1000) + (diff[1] / 1000000))
}

export interface ServiceClientRequestOptions extends RequestOptions {
  pathname: string
  query?: object
  timing?: boolean
  dropRequestAfter?: number
  body?: any
}

export class ServiceClientResponse {
  timings?: Timings
  timingPhases?: TimingPhases
  constructor (public statusCode: number, public headers: IncomingHttpHeaders, public body: any, public request: ServiceClientRequestOptions) {
    this.statusCode = statusCode
    this.headers = headers
    this.body = body
    this.request = request
  }

}

export type Timings = {
  lookup?: number,
  socket?: number,
  connect?: number,
  response?: number,
  end?: number
}
export type TimingPhases = {
  wait?: number,
  dns?: number,
  tcp?: number,
  firstByte?: number,
  download?: number,
  total?: number
}

const subtract = (a?: number, b?: number): number | undefined => {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }
  return undefined
}

const makeTimingPhases = (timings: Timings): TimingPhases => {
  return {
    wait: timings.socket,
    dns: subtract(timings.lookup, timings.socket),
    tcp: subtract(timings.connect, timings.lookup),
    firstByte: subtract(timings.response, timings.connect),
    download: subtract(timings.end, timings.response),
    total: timings.end
  }
}

export const request = (options: ServiceClientRequestOptions): Promise<ServiceClientResponse> => {
  options = Object.assign({
    protocol: 'https:'
  }, options)

  if ('pathname' in options && !('path' in options)) {
    if ('query' in options) {
      options.path = `${options.pathname}?${querystring.stringify(options.query)}`
    } else {
      options.path = options.pathname
    }
  }

  const httpRequestFn = options.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((resolve, originalReject) => {
    let hasRequestEnded = false
    let startTime: [number, number]
    let timings: Timings
    let reject = originalReject
    if (options.timing) {
      startTime = process.hrtime()
      timings = {
        lookup: undefined,
        socket: undefined,
        connect: undefined,
        response: undefined,
        end: undefined
      }
      reject = (error: Error) => {
        Object.assign(error, {
          timings,
          timingPhases: makeTimingPhases(timings)
        })
        originalReject(error)
      }
    }
    const request = httpRequestFn(options, (response: IncomingMessage) => {
      if (options.timing) {
        if (timings.lookup === undefined) {
          timings.lookup = timings.socket
        }
        if (timings.connect === undefined) {
          timings.connect = timings.socket
        }
        timings.response = getInterval(startTime)
      }
      let bodyStream
      const chunks: Buffer[] = []
      const encoding = response.headers && response.headers['content-encoding']
      if (encoding === 'gzip' || encoding === 'deflate') {
        response.on('error', reject)
        bodyStream = response.pipe(zlib.createUnzip())
      } else {
        bodyStream = response
      }
      bodyStream.on('error', reject)
      bodyStream.on('data', (chunk) => {
        if (chunk instanceof Buffer) {
          chunks.push(chunk)
        } else {
          chunks.push(Buffer.from(chunk, 'utf-8'))
        }
      })
      bodyStream.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        hasRequestEnded = true
        const serviceClientResponse = new ServiceClientResponse(response.statusCode || 0, response.headers, body, options)
        if (options.timing) {
          timings.end = getInterval(startTime)
          serviceClientResponse.timings = timings
          serviceClientResponse.timingPhases = makeTimingPhases(timings)
        }
        resolve(Object.assign(serviceClientResponse, response))
      })
    })
    if (options.timing) {
      request.once('socket', (socket) => {
        timings.socket = getInterval(startTime)
        if (socket.connecting) {
          const onLookUp = () => {
            timings.lookup = getInterval(startTime)
          }
          const onConnect = () => {
            timings.connect = getInterval(startTime)
          }
          socket.once('lookup', onLookUp)
          socket.once('connect', onConnect)
          request.once('error', () => {
            socket.removeListener('lookup', onLookUp)
            socket.removeListener('connect', onConnect)
          })
        } else {
          timings.lookup = timings.socket
          timings.connect = timings.socket
        }
      })
    }
    request.on('error', reject)
    request.on('timeout', () => {
      request.abort()
      reject(new Error('socket timeout'))
    })
    if (options.dropRequestAfter) {
      setTimeout(() => {
        if (!hasRequestEnded) {
          request.abort()
          reject(new Error('request timeout'))
        }
      }, options.dropRequestAfter)
    }
    if (options.body) {
      request.write(options.body)
    }
    request.end()
  })
}
