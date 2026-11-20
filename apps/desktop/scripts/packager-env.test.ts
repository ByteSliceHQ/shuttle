import { describe, expect, test } from 'bun:test'

import { packagerEnvironment } from './packager-env'

const blankCertificate = {
  SHUTTLE_DESKTOP_URL: 'https://app.shuttle.codes',
  CSC_LINK: '',
  CSC_KEY_PASSWORD: '',
  CSC_NAME: '',
}

describe('packager environment', () => {
  test('an unsigned build does not receive a blank certificate', () => {
    const env = packagerEnvironment(blankCertificate, false)

    expect(env.SHUTTLE_DESKTOP_URL).toBe('https://app.shuttle.codes')
    expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('false')
    expect(env.CSC_LINK).toBeUndefined()
    expect(env.CSC_KEY_PASSWORD).toBeUndefined()
    expect(env.CSC_NAME).toBeUndefined()
  })

  test('a signed build keeps the certificate', () => {
    const env = packagerEnvironment(
      {
        ...blankCertificate,
        CSC_LINK: 'cert',
        CSC_KEY_PASSWORD: 'secret',
        CSC_NAME: 'Developer ID Application: ByteSlice',
      },
      true,
    )

    expect(env.CSC_LINK).toBe('cert')
    expect(env.CSC_KEY_PASSWORD).toBe('secret')
    expect(env.CSC_NAME).toBe('Developer ID Application: ByteSlice')
    expect(env.CSC_IDENTITY_AUTO_DISCOVERY).toBeUndefined()
  })
})
