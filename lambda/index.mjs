import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const eligibleSource = /\.(jpe?g|png|webp)$/i
const configuration = {
  allowed_widths: (process.env.ALLOWED_WIDTHS || '').split(',').filter(Boolean).map(Number),
  asset_prefix: process.env.ASSET_PREFIX || 'assets',
}

const decode = (value) => {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export const parseTransformation = (uri, configuration) => {
  const [, prefix, assetIdValue, contentVersionValue, widthValue, format, outputFilenameValue, ...rest] = uri.split('/')
  if (prefix !== configuration.asset_prefix || rest.length || !assetIdValue || !contentVersionValue || !widthValue || !format || !outputFilenameValue) return null

  const assetId = decode(assetIdValue)
  const contentVersion = decode(contentVersionValue)
  const width = Number(widthValue)
  const outputFilename = decode(outputFilenameValue)
  const filename = format === 'source' ? outputFilename : outputFilename?.slice(0, -(format.length + 1))

  if (
    !assetId ||
    !contentVersion ||
    !outputFilename ||
    !filename ||
    String(width) !== widthValue ||
    !['source', 'webp'].includes(format) ||
    (format !== 'source' && !eligibleSource.test(filename)) ||
    (format === 'source' && width !== 0 && !eligibleSource.test(filename)) ||
    (width !== 0 && !configuration.allowed_widths.includes(width))
  ) return null

  const outputKey = `${configuration.asset_prefix}/${assetId}/${contentVersion}/${width}/${format}/${outputFilename}`
  const sourceKey = `${configuration.asset_prefix}/${assetId}/${contentVersion}/0/source/${filename}`

  return { assetId, contentVersion, format, outputKey, sourceKey, filename, width }
}

export const toS3Uri = (key) => `/${key.split('/').map(encodeURIComponent).join('/')}`

export const createImageConverter = (sharp) => (input, { format, width }) => {
  const image = sharp(input, { limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: width || undefined, fit: 'inside', withoutEnlargement: true })
  return (format === 'source' ? image : image.toFormat(format, { quality: 80 }))
    .toBuffer()
}

const isNotFound = (error) => error?.$metadata?.httpStatusCode === 404 || error?.name === 'NoSuchKey'
const response = (stream, statusCode, headers = {}) =>
  awslambda.HttpResponseStream.from(stream, { statusCode, headers })
const sendError = (stream, statusCode, message) =>
  pipeline(
    Readable.from([message]),
    response(stream, statusCode, {
      'cache-control': 'public, max-age=0, s-maxage=86400',
      'content-type': 'text/plain; charset=utf-8',
    }),
  )

export const createHandler = ({ convert, s3Client }) =>
  awslambda.streamifyResponse(async (event, responseStream) => {
    const transformation = parseTransformation(event.rawPath, configuration)
    if (!transformation) return sendError(responseStream, 400, 'Invalid image transformation')

    const { format, outputKey, sourceKey } = transformation

    // CloudFront already tries S3 first and only fails over here on 403, so the
    // derivative is known to be missing. Fetch just the source.
    let source
    try {
      source = await s3Client.send(new GetObjectCommand({ Bucket: process.env.MEDIA_BUCKET, Key: sourceKey }))
    } catch (error) {
      if (!isNotFound(error)) throw error
      return sendError(responseStream, 404, 'Source image not found')
    }

    if (format === 'source' && transformation.width === 0) {
      return pipeline(source.Body, response(responseStream, 200, {
        'cache-control': source.CacheControl || 'public, max-age=31536000, immutable',
        'content-type': source.ContentType || 'application/octet-stream',
        ...(source.ContentLength != null && { 'content-length': String(source.ContentLength) }),
        ...(source.ETag && { etag: source.ETag }),
      }))
    }

    const originalHeaders = { 'cache-control': 'no-store', 'content-type': source.ContentType || 'application/octet-stream' }
    if (source.ContentLength > 20_000_000) {
      return pipeline(source.Body, response(responseStream, 200, originalHeaders))
    }

    const input = Buffer.from(await source.Body.transformToByteArray())
    let body
    try {
      body = await convert(input, transformation)
    } catch {
      return pipeline(Readable.from([input]), response(responseStream, 200, originalHeaders))
    }

    const contentType = format === 'source'
      ? source.ContentType || 'application/octet-stream'
      : `image/${format}`
    const stored = await s3Client.send(new PutObjectCommand({
      Bucket: process.env.MEDIA_BUCKET,
      Key: outputKey,
      Body: body,
      CacheControl: 'public, max-age=31536000, immutable',
      ContentType: contentType,
    }))
    return pipeline(Readable.from([body]), response(responseStream, 200, {
      'cache-control': 'public, max-age=31536000, immutable',
      'content-type': contentType,
      'content-length': String(body.length),
      ...(stored.ETag && { etag: stored.ETag }),
    }))
  })

const sharp = process.env.AWS_LAMBDA_FUNCTION_NAME ? (await import('sharp')).default : null

export const handler = sharp
  ? createHandler({ convert: createImageConverter(sharp), s3Client: new S3Client({}) })
  : undefined
