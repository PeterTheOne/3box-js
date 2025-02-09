const Pubsub = require('orbit-db-pubsub')

const testUtils = require('./testUtils')
const Box = require('../3box')
const IdentityWallet = require('identity-wallet')

const PINNING_ROOM = '3box-pinning'

jest.mock('node-fetch', () => {
  const rootStoreAddress = '/orbitdb/QmZggbAyvHMBgQX6vSFXpG31BvqwVAiLF6UUJn4s91ZUP2/122099b9c5866419e91e3d470b364b721e4b43e9f699fb0b032bdc0d402a0ac41a27.root'
  let called = false
  return (url, opts) => {
    //console.log('fetch', url, opts)
    const ethAddr = url.split('/')[5]
    if (ethAddr && called) {
      return {
        ok: true,
        json: () => {
          return { data: { rootStoreAddress } }
        }
      }
    } else if (ethAddr) {
      called = true
      return {
        ok: false,
        status: 404,
        json: () => {
          return { message: 234 }
        }
      }
    }
    return {
      ok: true,
      json: () => {
        return { data: 234 }
      }
    }
  }
})

const utils = require('../utils/index')
utils.recoverPersonalSign = () => '0x2D10ce5C50000496715891073804577E0Af964C0'

const mockEthProvider = {
  sendAsync: (d, fn) => {
    if (d.method.startsWith('3id')) {
      fn('error!')
    } else {
      fn(null, 0x12345)
    }
  }
}


describe('Integration Test: IdentityWallet', () => {
  let ipfs1, ipfs2
  let ipfsMultiAddr2
  let pubsub
  jest.setTimeout(30000)
  let idWallet, opts, pubState
  let rootStoreAddress, pubAddr, privAddr

  const SEED = '0x95838ece1ac686bde68823b21ce9f564bc536eebb9c3500fa6da81f17086a6be'
  const ADDRESS = '0x2D10ce5C50000496715891073804577E0Af964C0'
  const AUTH_1 = '68b682d67f0fccb0c56236c27ccdd70577722c385c65c00ed1c3d4fbee57db3c'
  const AUTH_2 = '05273ade0b139165d9e5864a18d1ad6b291a1a1ebc841fd68d126c593c89ce7f '
  const publishHasEntries = async () => {
    await testUtils.delay(900)
    pubsub.publish(PINNING_ROOM, { type: 'HAS_ENTRIES', odbAddress: rootStoreAddress, numEntries: 2 })
    pubsub.publish(PINNING_ROOM, { type: 'HAS_ENTRIES', odbAddress: privAddr, numEntries: 0 })
    pubsub.publish(PINNING_ROOM, { type: 'HAS_ENTRIES', odbAddress: pubAddr, numEntries: 2 })
  }

  beforeAll(async () => {
    ipfs1 = await testUtils.initIPFS(9)
    ipfs2 = await testUtils.initIPFS(10)
    ipfsMultiAddr2 = (await ipfs2.id()).addresses[0]
    pubsub = new Pubsub(ipfs2, (await ipfs2.id()).id)
    opts = {
      ipfs: ipfs1,
      orbitPath: './tmp/orbitdb7',
      identityKeysPath: `./tmp/did1`,
      pinningNode: ipfsMultiAddr2
    }
  })

  beforeEach(async () => {
    idWallet = new IdentityWallet({ seed: SEED })
    pubsub.subscribe(PINNING_ROOM, (topic, data) => {}, () => {})
  })

  afterAll(async () => {
    //await testutils.stopipfs(ipfs1, 9)
    //await testUtils.stopIPFS(ipfs2, 10)
  })

  it('should openBox correctly when idWallet is passed', async () => {
    const provider = idWallet.get3idProvider()
    // monkey patch because we're not using latest version of idwallet
    provider.is3idProvider = true
    const box = await Box.openBox(null, provider, opts)
    await box.syncDone
    await box.public.set('a', 1)
    await box.public.set('b', 2)
    await box.public.set('c', 3)
    rootStoreAddress = box.replicator.rootstore.address.toString()
    pubAddr = box.public._db.address.toString()
    privAddr = box.private._db.address.toString()
    pubState = await box.public.all()
    await box.close()
  })

  it('should get same state on second openBox', async () => {
    publishHasEntries()
    const provider = idWallet.get3idProvider()
    // monkey patch because we're not using latest version of idwallet
    provider.is3idProvider = true
    const box = await Box.openBox(null, provider, opts)
    await box.syncDone
    expect(await box.public.all()).toEqual(pubState)

    expect(box.replicator.rootstore._oplog.values.length).toEqual(3)
    idWallet.addAuthMethod(AUTH_1)
    await testUtils.delay(800)
    expect(box.replicator.rootstore._oplog.values.length).toEqual(4)

    await box.close()
  })

  it('should get same state on openBox with IdentityWallet opened using first authSecret', async () => {
    publishHasEntries()
    idWallet = new IdentityWallet({ authSecret: AUTH_1, ethereumAddress: ADDRESS })
    const provider = idWallet.get3idProvider()
    // monkey patch because we're not using latest version of idwallet
    provider.is3idProvider = true
    const box = await Box.openBox(null, provider, opts)
    await box.syncDone
    expect(await box.public.all()).toEqual(pubState)

    expect(box.replicator.rootstore._oplog.values.length).toEqual(4)
    idWallet.addAuthMethod(AUTH_2)
    await testUtils.delay(800)
    expect(box.replicator.rootstore._oplog.values.length).toEqual(5)

    await box.close()
  })

  it('should get same state on openBox with IdentityWallet opened using second authSecret', async () => {
    publishHasEntries()
    idWallet = new IdentityWallet({ authSecret: AUTH_2, ethereumAddress: ADDRESS })
    const provider = idWallet.get3idProvider()
    // monkey patch because we're not using latest version of idwallet
    provider.is3idProvider = true
    const box = await Box.openBox(null, provider, opts)
    await box.syncDone
    expect(await box.public.all()).toEqual(pubState)
    await box.close()
  })
})
