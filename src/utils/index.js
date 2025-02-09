const fetch = typeof window !== 'undefined' ? window.fetch : require('node-fetch')
const Multihash = require('multihashes')
const sha256 = require('js-sha256').sha256
const { Contract } = require('@ethersproject/contracts')
const { Web3Provider } = require('@ethersproject/providers')
const { verifyMessage } = require('@ethersproject/wallet')

const ENC_BLOCK_SIZE = 24
const MAGIC_ERC1271_VALUE = '0x20c13b0b'

const pad = (val, blockSize = ENC_BLOCK_SIZE) => {
  const blockDiff = (blockSize - (val.length % blockSize)) % blockSize
  return `${val}${'\0'.repeat(blockDiff)}`
}

const unpad = padded => padded.replace(/\0+$/, '')

const HTTPError = (status, message) => {
  const e = new Error(message)
  e.statusCode = status
  return e
}

const getMessageConsent = (did, timestamp) => {
  let msg = 'Create a new 3Box profile' + '\n\n' + '- \n' + 'Your unique profile ID is ' + did
  if (timestamp) msg += ' \n' + 'Timestamp: ' + timestamp
  return msg
}

const safeSend = (provider, data) => {
  const send = (Boolean(provider.sendAsync) ? provider.sendAsync : provider.send).bind(provider)
  return new Promise((resolve, reject) => {
    send(data, function(err, result) {
      if (err) reject(err)
      else if (result.error) reject(result.error)
      else resolve(result.result)
    })
  })
}

const encodeRpcCall = (method, params) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params
})

const callRpc = async (provider, method, params) => safeSend(provider, encodeRpcCall(method, params))

module.exports = {
  getMessageConsent,
  callRpc,

  recoverPersonalSign: (msg, personalSig) => {
    if (!msg || !personalSig) throw new Error('recoverPersonalSign: missing arguments, msg and/or personalSig')
    const msgParams = {
      data: msg,
      sig: personalSig
    }
    return verifyMessage(msg , personalSig)
  },

  openBoxConsent: (fromAddress, ethereum) => {
    const text = 'This app wants to view and update your 3Box profile.'
    var msg = '0x' + Buffer.from(text, 'utf8').toString('hex')
    var params = [msg, fromAddress]
    var method = 'personal_sign'
    return safeSend(ethereum, {
      jsonrpc: '2.0',
      id: 0,
      method,
      params,
      fromAddress
    })
  },

  openSpaceConsent: (fromAddress, ethereum, name) => {
    const text = `Allow this app to open your ${name} space.`
    var msg = '0x' + Buffer.from(text, 'utf8').toString('hex')
    var params = [msg, fromAddress]
    var method = 'personal_sign'
    return safeSend(ethereum, {
      jsonrpc: '2.0',
      id: 0,
      method,
      params,
      fromAddress
    })
  },

  getLinkConsent: async (fromAddress, toDID, ethereum) => {
    const timestamp = Math.floor(new Date().getTime() / 1000)
    const text = getMessageConsent(toDID, timestamp)
    const msg = '0x' + Buffer.from(text, 'utf8').toString('hex')
    const params = [msg, fromAddress]
    const method = 'personal_sign'

    const sig = await safeSend(ethereum, {
      jsonrpc: '2.0',
      id: 0,
      method,
      params,
      fromAddress
    })
    return {
      msg: text,
      sig,
      timestamp
    }
  },

  getChainId: async (ethereumProvider) => {
    const method = 'eth_chainId'
    const params = []

    const chainIdHex = await safeSend(ethereumProvider, {
      jsonrpc: '2.0',
      id: 0,
      method,
      params
    })
    return parseInt(chainIdHex, 16)
  },

  getCode: async (ethereumProvider, address) => {
    const method = 'eth_getCode'
    const params = [address]

    const code = await safeSend(ethereumProvider, {
      jsonrpc: '2.0',
      id: 1,
      method,
      params
    })
    return code
  },

  isValidSignature: async (linkObj, isErc1271, web3Provider) => {
    if (!linkObj.address) return false
    if (!isErc1271) return true

    const abi = [
      'function isValidSignature(bytes _messageHash, bytes _signature) public view returns (bytes4 magicValue)'
    ]
    const ethersProvider = new Web3Provider(web3Provider)
    const contract = new Contract(linkObj.address, abi, ethersProvider)
    const message = '0x' + Buffer.from(linkObj.message, 'utf8').toString('hex')
    const returnValue = await contract.isValidSignature(message, linkObj.signature)

    return returnValue === MAGIC_ERC1271_VALUE
  },

  fetchJson: async (url, body) => {
    let opts
    if (body) {
      opts = { body: JSON.stringify(body), method: 'POST', headers: { 'Content-Type': 'application/json' } }
    }
    const r = await fetch(url, opts)

    if (r.ok) {
      return r.json()
    } else {
      throw HTTPError(r.status, (await r.json()).message)
    }
  },

  fetchText: async (url, opts) => {
    const r = await fetch(url, opts)

    if (r.ok) {
      return r.text()
    } else {
      throw HTTPError(r.status, `Invalid response (${r.status}) for query at ${url}`)
    }
  },

  throwIfUndefined: (arg, name) => {
    if (arg === undefined || arg === null) {
      throw new Error(`${name} is a required argument`)
    }
  },

  throwIfNotEqualLenArrays: (arr1, arr2) => {
    if (!Array.isArray(arr1) || !Array.isArray(arr2)) {
      throw new Error('One or more arguments are not an array')
    }

    if (arr1.length !== arr2.length) {
      throw new Error('Arrays must be of the same length')
    }
  },

  sha256Multihash: str => {
    const digest = Buffer.from(sha256.digest(str))
    return Multihash.encode(digest, 'sha2-256').toString('hex')
  },
  randInt: max => Math.floor(Math.random() * max),
  sha256,
  pad,
  unpad
}
