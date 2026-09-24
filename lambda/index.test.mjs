import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable, Writable } from 'node:stream'
import sharp from 'sharp'

import { createHandler, createImageConverter, parseTransformation, toS3Uri } from './index.mjs'

const configuration = { allowed_widths: [320, 640], asset_prefix: 'assets' }

test('maps direct derivative paths to their exact immutable source and rejects invalid combinations', () => {
  const transformation = parseTransformation(
    '/assets/asset-id/content-version/640/webp/my%20image.jpg.webp',
    configuration,
  )

  assert.deepEqual(transformation, {
    assetId: 'asset-id',
    contentVersion: 'content-version',
    format: 'webp',
    outputKey: 'assets/asset-id/content-version/640/webp/my image.jpg.webp',
    sourceKey: 'assets/asset-id/content-version/0/source/my image.jpg',
    filename: 'my image.jpg',
    width: 640,
  })
  assert.equal(
    toS3Uri(transformation.outputKey),
    '/assets/asset-id/content-version/640/webp/my%20image.jpg.webp',
  )

  assert.deepEqual(
    parseTransformation(
      '/assets/asset-id/content-version/0/webp/my%20image.jpg.webp',
      configuration,
    ),
    {
      assetId: 'asset-id',
      contentVersion: 'content-version',
      format: 'webp',
      outputKey: 'assets/asset-id/content-version/0/webp/my image.jpg.webp',
      sourceKey: 'assets/asset-id/content-version/0/source/my image.jpg',
      filename: 'my image.jpg',
      width: 0,
    },
  )
  assert.deepEqual(
    parseTransformation('/assets/asset-id/content-version/0/source/my%20image.jpg', configuration),
    {
      assetId: 'asset-id',
      contentVersion: 'content-version',
      format: 'source',
      outputKey: 'assets/asset-id/content-version/0/source/my image.jpg',
      sourceKey: 'assets/asset-id/content-version/0/source/my image.jpg',
      filename: 'my image.jpg',
      width: 0,
    },
  )
  assert.equal(
    parseTransformation(
      '/assets/asset-id/content-version/640/webp/photo.v2.jpeg.webp',
      configuration,
    )?.sourceKey,
    'assets/asset-id/content-version/0/source/photo.v2.jpeg',
  )

  assert.deepEqual(
    parseTransformation('/assets/asset-id/content-version/640/source/image.jpg', configuration),
    {
      assetId: 'asset-id',
      contentVersion: 'content-version',
      format: 'source',
      outputKey: 'assets/asset-id/content-version/640/source/image.jpg',
      sourceKey: 'assets/asset-id/content-version/0/source/image.jpg',
      filename: 'image.jpg',
      width: 640,
    },
  )
  assert.equal(
    parseTransformation('/assets/asset-id/content-version/640/source/video.mp4', configuration),
    null,
  )
  assert.equal(
    parseTransformation('/assets/asset-id/content-version/00/source/image.jpg', configuration),
    null,
  )
  assert.equal(
    parseTransformation('/assets/asset-id/content-version/0640/webp/image.jpg.webp', configuration),
    null,
  )
  assert.equal(
    parseTransformation('/assets/asset-id/content-version/0/jpeg/image.jpg.jpeg', configuration),
    null,
  )
  assert.equal(
    parseTransformation('/assets/asset-id/content-version/800/webp/image.jpg.webp', configuration),
    null,
  )
  assert.equal(
    parseTransformation('/assets/asset-id/content-version/640/webp/image.gif.webp', configuration),
    null,
  )
  assert.equal(
    parseTransformation('/assets/asset-id/content-version/640/webp/video.mp4.webp', configuration),
    null,
  )
  assert.equal(
    parseTransformation('/assets/asset-id/content-version/640/webp/image.svg.webp', configuration),
    null,
  )
  assert.equal(
    parseTransformation('/assets/asset-id/content-version/640/avif/image.jpg.avif', configuration),
    null,
  )
  assert.deepEqual(
    parseTransformation('/assets/asset-id/%2E%2E/0/webp/image.jpg.webp', configuration),
    {
      assetId: 'asset-id',
      contentVersion: '..',
      format: 'webp',
      outputKey: 'assets/asset-id/../0/webp/image.jpg.webp',
      sourceKey: 'assets/asset-id/../0/source/image.jpg',
      filename: 'image.jpg',
      width: 0,
    },
  )
})

test('auto-orients mirrored/rotated sources before WebP conversion', async () => {
  const convertImage = createImageConverter(sharp)
  for (const orientation of [5, 6]) {
    const source = await sharp({
      create: { width: 20, height: 30, channels: 3, background: 'red' },
    })
      .jpeg()
      .withMetadata({ orientation })
      .toBuffer()

    const output = await convertImage(source, { format: 'webp', width: 40 })
    const metadata = await sharp(output).metadata()
    assert.equal(metadata.width, 30)
    assert.equal(metadata.height, 20)
  }
})

test('resizes a source derivative without changing its image format', async () => {
  const convertImage = createImageConverter(sharp)
  const source = await sharp({
    create: { width: 800, height: 600, channels: 3, background: 'red' },
  }).png().toBuffer()

  const output = await convertImage(source, { format: 'source', width: 320 })
  const metadata = await sharp(output).metadata()

  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 320)
  assert.equal(metadata.height, 240)
})

test('fetches only the source, stores the derivative and streams it with byte length and S3 ETag', async () => {
  const body = Buffer.from([0, 255, 128, 42])
  const etag = '"s3-object-etag"'
  const originalLambda = globalThis.awslambda
  try {
    let metadata
    const chunks = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })
    globalThis.awslambda = {
      streamifyResponse: (handler) => handler,
      HttpResponseStream: {
        from: (output, headers) => {
          metadata = headers
          return output
        },
      },
    }
    const requests = []
    const handler = createHandler({
      convert: async () => body,
      s3Client: {
        send: async (command) => {
          requests.push(command.input)
          if (command.input.Body) {
            assert.equal(command.input.Key, 'assets/id/v1/0/webp/photo.jpg.webp')
            assert.equal(command.input.ContentType, 'image/webp')
            assert.equal(command.input.CacheControl, 'public, max-age=31536000, immutable')
            assert.deepEqual(Buffer.from(command.input.Body), body)
            return { ETag: etag }
          }
          assert.equal(command.input.Key, 'assets/id/v1/0/source/photo.jpg')
          return {
            Body: { transformToByteArray: async () => Buffer.from('original') },
            ContentLength: 8,
            ContentType: 'image/jpeg',
          }
        },
      },
    })
    await handler({ rawPath: '/assets/id/v1/0/webp/photo.jpg.webp' }, stream)
    assert.equal(metadata.statusCode, 200)
    assert.equal(metadata.headers['content-length'], '4')
    assert.equal(metadata.headers.etag, etag)
    assert.equal(metadata.headers['content-type'], 'image/webp')
    assert.equal(metadata.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.deepEqual(Buffer.concat(chunks), body)
    assert.equal(requests.length, 2)
  } finally {
    globalThis.awslambda = originalLambda
  }
})

test('streams the source directly when the derivative is the source', async () => {
  const originalLambda = globalThis.awslambda
  try {
    let metadata
    const chunks = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })
    globalThis.awslambda = {
      streamifyResponse: (handler) => handler,
      HttpResponseStream: {
        from: (output, headers) => {
          metadata = headers
          return output
        },
      },
    }
    let calls = 0
    const handler = createHandler({
      convert: async () => {
        throw new Error('must not convert a source passthrough')
      },
      s3Client: {
        send: async (command) => {
          calls += 1
          assert.equal(command.input.Key, 'assets/id/v1/0/source/photo.jpg')
          return {
            Body: Readable.from(Buffer.from('original')),
            ContentLength: 8,
            ContentType: 'image/jpeg',
            ETag: '"source-etag"',
          }
        },
      },
    })
    await handler({ rawPath: '/assets/id/v1/0/source/photo.jpg' }, stream)
    assert.equal(metadata.statusCode, 200)
    assert.equal(metadata.headers['content-type'], 'image/jpeg')
    assert.equal(metadata.headers['content-length'], '8')
    assert.equal(metadata.headers.etag, '"source-etag"')
    assert.equal(metadata.headers['cache-control'], 'public, max-age=31536000, immutable')
    assert.deepEqual(Buffer.concat(chunks), Buffer.from('original'))
    assert.equal(calls, 1)
  } finally {
    globalThis.awslambda = originalLambda
  }
})

test('returns 404 without converting when the source is missing', async () => {
  const originalLambda = globalThis.awslambda
  try {
    let metadata
    const chunks = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })
    globalThis.awslambda = {
      streamifyResponse: (handler) => handler,
      HttpResponseStream: {
        from: (output, headers) => {
          metadata = headers
          return output
        },
      },
    }
    let calls = 0
    const handler = createHandler({
      convert: async () => {
        throw new Error('must not convert a missing source')
      },
      s3Client: {
        send: async () => {
          calls += 1
          throw { name: 'NoSuchKey' }
        },
      },
    })
    await handler({ rawPath: '/assets/id/v1/0/webp/photo.jpg.webp' }, stream)
    assert.equal(metadata.statusCode, 404)
    assert.equal(metadata.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(metadata.headers['cache-control'], 'public, max-age=0, s-maxage=86400')
    assert.equal(Buffer.concat(chunks).toString(), 'Source image not found')
    assert.equal(calls, 1)
  } finally {
    globalThis.awslambda = originalLambda
  }
})

test('passes oversize sources through without converting or storing', async () => {
  const originalLambda = globalThis.awslambda
  try {
    let metadata
    const chunks = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })
    globalThis.awslambda = {
      streamifyResponse: (handler) => handler,
      HttpResponseStream: {
        from: (output, headers) => {
          metadata = headers
          return output
        },
      },
    }
    let calls = 0
    const handler = createHandler({
      convert: async () => {
        throw new Error('must not convert an oversize source')
      },
      s3Client: {
        send: async () => {
          calls += 1
          return {
            Body: Readable.from(Buffer.from('original')),
            ContentLength: 20_000_001,
            ContentType: 'image/jpeg',
          }
        },
      },
    })
    await handler({ rawPath: '/assets/id/v1/0/webp/photo.jpg.webp' }, stream)
    assert.equal(metadata.statusCode, 200)
    assert.equal(metadata.headers['content-type'], 'image/jpeg')
    assert.equal(metadata.headers['cache-control'], 'no-store')
    assert.deepEqual(Buffer.concat(chunks), Buffer.from('original'))
    assert.equal(calls, 1)
  } finally {
    globalThis.awslambda = originalLambda
  }
})

test('returns original bytes without storing or caching after a failed conversion', async () => {
  let metadata
  let responseFinished = false
  const chunks = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
    final(callback) {
      setImmediate(() => {
        responseFinished = true
        callback()
      })
    },
  })
  const originalLambda = globalThis.awslambda
  globalThis.awslambda = {
    streamifyResponse: (handler) => handler,
    HttpResponseStream: {
      from: (output, headers) => {
        metadata = headers
        return output
      },
    },
  }

  try {
    let calls = 0
    const handler = createHandler({
      convert: async () => {
        throw new Error('conversion failed')
      },
      s3Client: {
        send: async () => {
          calls += 1
          return {
            ContentType: 'image/jpeg',
            Body: { transformToByteArray: async () => Buffer.from('original') },
          }
        },
      },
    })
    await handler(
      {
        rawPath: '/assets/id/v1/0/webp/photo.jpg.webp',
        requestContext: { requestId: 'request-123' },
      },
      stream,
    )

    assert.equal(metadata.statusCode, 200)
    assert.equal(metadata.headers['content-type'], 'image/jpeg')
    assert.equal(metadata.headers['cache-control'], 'no-store')
    assert.equal(Buffer.concat(chunks).toString(), 'original')
    assert.equal(responseFinished, true)
    assert.equal(calls, 1)
  } finally {
    globalThis.awslambda = originalLambda
  }
})
