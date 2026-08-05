import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12

function getEncryptionKey() {
  const encodedKey =
    process.env.ALLEGRO_TOKEN_ENCRYPTION_KEY

  if (!encodedKey) {
    throw new Error(
      'ALLEGRO_TOKEN_ENCRYPTION_KEY is not configured',
    )
  }

  const key = Buffer.from(encodedKey, 'base64')

  if (key.length !== 32) {
    throw new Error(
      'ALLEGRO_TOKEN_ENCRYPTION_KEY must contain exactly 32 bytes',
    )
  }

  return key
}

export function encryptSecret(value: string) {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)

  const cipher = createCipheriv(
    ALGORITHM,
    key,
    iv,
  )

  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ])

  const authTag = cipher.getAuthTag()

  return [
    'v1',
    iv.toString('base64'),
    authTag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':')
}

export function decryptSecret(value: string) {
  const [version, ivValue, authTagValue, encryptedValue] =
    value.split(':')

  if (
    version !== 'v1' ||
    !ivValue ||
    !authTagValue ||
    !encryptedValue
  ) {
    throw new Error(
      'Invalid encrypted secret format',
    )
  }

  const key = getEncryptionKey()

  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(ivValue, 'base64'),
  )

  decipher.setAuthTag(
    Buffer.from(authTagValue, 'base64'),
  )

  const decrypted = Buffer.concat([
    decipher.update(
      Buffer.from(encryptedValue, 'base64'),
    ),
    decipher.final(),
  ])

  return decrypted.toString('utf8')
}