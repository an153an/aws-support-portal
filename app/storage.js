const crypto = require('crypto');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Attachments live under attachments/ in the (private) assets bucket. The app
// never exposes the bucket: downloads are short-lived presigned URLs.
const bucket = process.env.ASSETS_BUCKET;
const client = new S3Client({});

const enabled = () => !!bucket;
const URL_TTL_SECONDS = 300;

// Keeps only safe characters so the name is harmless in a key and a header.
const safeName = (name) => String(name).split(/[\\/]/).pop().replace(/[^A-Za-z0-9._ -]/g, '_').slice(-100) || 'file';

const keyFor = (ticketId, filename) => `attachments/${ticketId}/${crypto.randomUUID()}-${safeName(filename)}`;

async function put(key, body, contentType) {
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: 'AES256' }));
}

async function remove(key) {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

// A time-limited link that makes the browser download the file under its original name.
function downloadUrl(key, filename) {
  return getSignedUrl(client, new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${safeName(filename)}"`,
  }), { expiresIn: URL_TTL_SECONDS });
}

module.exports = { enabled, safeName, keyFor, put, remove, downloadUrl };
