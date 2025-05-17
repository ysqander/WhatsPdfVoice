import { describe, it, expect, vi, beforeEach } from 'vitest'
// Provide dummy env vars so Stripe initialization does not throw
process.env.STRIPE_SECRET_KEY = 'test_key'

vi.mock('../db', () => ({ db: {} }))
vi.mock('../storage', () => ({
  storage: {
    getChatExport: vi.fn(),
    getMessagesByChatExportId: vi.fn(),
    uploadMediaToR2: vi.fn(),
    savePdfUrl: vi.fn(),
    getMediaFile: vi.fn(),
  },
}))
vi.mock('../mediaProxyStorage', () => ({
  mediaProxyStorage: {
    createMediaProxy: vi.fn(),
  },
}))
vi.mock('../lib/pdf', () => ({
  generatePdf: vi.fn().mockResolvedValue('/tmp/test.pdf'),
}))
vi.mock('../lib/r2Storage', () => ({
  getSignedR2Url: vi.fn().mockResolvedValue('https://r2.example/test.pdf'),
}))

const { storage } = await import('../storage')
const { mediaProxyStorage } = await import('../mediaProxyStorage')
const { generatePdf } = await import('../lib/pdf')
const { PaymentService } = await import('../lib/paymentService')

const paymentService = new PaymentService()

describe('PaymentService.ensurePdfGeneratedAndLinked', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('saves a PDF URL after generation', async () => {
    storage.getChatExport.mockResolvedValue({ id: 1, originalFilename: 'chat.zip', fileHash: 'hash', processingOptions: {}, pdfUrl: null })
    storage.getMessagesByChatExportId.mockResolvedValue([
      { id: 1, chatExportId: 1, timestamp: new Date(), sender: 'A', content: 'hi', type: 'text' },
    ])
    storage.uploadMediaToR2.mockResolvedValue({ id: 'pdf1', key: 'pdfkey', url: 'https://r2/test.pdf' })
    mediaProxyStorage.createMediaProxy.mockResolvedValue({ id: 'proxy1', r2Key: 'pdfkey', r2Url: 'https://r2/test.pdf' })

    const bundle = { bundleId: 'b', chatExportId: 1, paidAt: new Date() } as any
    await paymentService.ensurePdfGeneratedAndLinked(bundle)

    expect(generatePdf).toHaveBeenCalled()
    expect(storage.uploadMediaToR2).toHaveBeenCalled()
    expect(storage.savePdfUrl).toHaveBeenCalledWith(1, expect.stringContaining('/api/media/proxy/'))
  })

  it('uses proxy URLs in messages when generating PDF', async () => {
    storage.getChatExport.mockResolvedValue({ id: 2, originalFilename: 'chat.zip', fileHash: 'hash', processingOptions: {}, pdfUrl: null })
    storage.getMessagesByChatExportId.mockResolvedValue([
      { id: 1, chatExportId: 2, timestamp: new Date(), sender: 'A', content: 'voice', type: 'voice', mediaUrl: '/api/media/proxy/m1' },
    ])
    storage.uploadMediaToR2.mockResolvedValue({ id: 'pdf2', key: 'pdfkey2', url: 'https://r2/test2.pdf' })
    mediaProxyStorage.createMediaProxy.mockResolvedValue({ id: 'proxy2', r2Key: 'pdfkey2', r2Url: 'https://r2/test2.pdf' })

    const bundle = { bundleId: 'b2', chatExportId: 2, paidAt: new Date() } as any
    await paymentService.ensurePdfGeneratedAndLinked(bundle)

    const call = (generatePdf as any).mock.calls[0][0]
    expect(call.messages[0].mediaUrl).toContain('/api/media/proxy/')
  })
})
