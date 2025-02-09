const localstorage = require('store')
const IPFS = require('ipfs')
const registerResolver = require('3id-resolver')

const ThreeId = require('./3id')
const Replicator = require('./replicator')
const PublicStore = require('./publicStore')
const PrivateStore = require('./privateStore')
const Verified = require('./verified')
const Space = require('./space')
const utils = require('./utils/index')
const idUtils = require('./utils/id')
const config = require('./config.js')
const API = require('./api')
const IPFSRepo = require('ipfs-repo')
const LevelStore = require('datastore-level')

const ACCOUNT_TYPES = {
  ethereum: 'ethereum',
  ethereumEOA: 'ethereum-eoa',
  erc1271: 'erc1271'
}

const PINNING_NODE = config.pinning_node
const ADDRESS_SERVER_URL = config.address_server_url
const IPFS_OPTIONS = config.ipfs_options

let globalIPFS // , ipfsProxy, cacheProxy, iframeLoadedPromise

/*
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const iframe = document.createElement('iframe')
  iframe.src = IFRAME_STORE_URL
  iframe.style = 'width:0; height:0; border:0; border:none !important'

  iframeLoadedPromise = new Promise((resolve, reject) => {
    iframe.onload = () => { resolve() }
  })

  document.body.appendChild(iframe)
  // Create proxy clients that talks to the iframe
  const postMessage = iframe.contentWindow.postMessage.bind(iframe.contentWindow)
  ipfsProxy = createProxyClient({ postMessage })
  cacheProxy = OrbitDBCacheProxy({ postMessage })
} */

class Box {
  /**
   * Please use the **openBox** method to instantiate a 3Box
   */
  constructor (threeId, provider, ipfs, opts = {}) {
    this._3id = threeId
    this._web3provider = provider
    this._ipfs = ipfs
    registerResolver(this._ipfs, { pin: true })
    this._serverUrl = opts.addressServer || ADDRESS_SERVER_URL
    /**
     * @property {KeyValueStore} public         access the profile store of the users 3Box
     */
    this.public = null
    /**
     * @property {KeyValueStore} private        access the private store of the users 3Box
     */
    this.private = null
    /**
     * @property {Verified} verified        check and create verifications
     */
    this.verified = new Verified(this)
    /**
     * @property {Object} spaces            an object containing all open spaces indexed by their name.
     */
    this.spaces = {}
    /**
     * @property {Promise} syncDone         A promise that is resolved when the box is synced
     */
    this.syncDone = null

    this.hasPublishedLink = {}
  }

  async _load (opts = {}) {
    this.replicator = await Replicator.create(this._ipfs, opts)

    const address = await this._3id.getAddress()
    const rootstoreAddress = address ? await this._getRootstore(address) : null
    if (rootstoreAddress) {
      await this.replicator.start(rootstoreAddress, { profile: true })
      await this.replicator.rootstoreSyncDone
      const authData = await this.replicator.getAuthData()
      await this._3id.authenticate(null, { authData })
    } else {
      await this._3id.authenticate()
      const rootstoreName = this._3id.muportFingerprint + '.root'
      const key = (await this._3id.getPublicKeys(null, true)).signingKey
      await this.replicator.new(rootstoreName, key, this.DID)
      this._publishRootStore(this.replicator.rootstore.address.toString())
    }
    this.replicator.rootstore.setIdentity(await this._3id.getOdbId())
    this.syncDone = this.replicator.syncDone

    this._3id.events.on('new-auth-method', authData => {
      this._writeRootstoreEntry(Replicator.entryTypes.AUTH_DATA, authData)
    })

    this.public = new PublicStore(this._3id.muportFingerprint + '.public', this._linkProfile.bind(this), this.replicator, this._3id)
    this.private = new PrivateStore(this._3id.muportFingerprint + '.private', this.replicator, this._3id)
    await this.public._load()
    await this.private._load()
  }

  /**
   * Get the public profile of a given address
   *
   * @param     {String}    address                 An ethereum address
   * @param     {Object}    opts                    Optional parameters
   * @param     {Function}  opts.blocklist          A function that takes an address and returns true if the user has been blocked
   * @param     {String}    opts.metadata           flag to retrieve metadata
   * @param     {String}    opts.addressServer      URL of the Address Server
   * @param     {Object}    opts.ipfs               A js-ipfs ipfs object
   * @param     {Boolean}   opts.useCacheService    Use 3Box API and Cache Service to fetch profile instead of OrbitDB. Default true.
   * @param     {String}    opts.profileServer      URL of Profile API server
   * @return    {Object}                            a json object with the profile for the given address
   */
  static async getProfile (address, opts = {}) {
    const metadata = opts.metadata
    opts = Object.assign({ useCacheService: true }, opts)

    let profile
    if (opts.useCacheService) {
      profile = await API.getProfile(address, opts.profileServer, { metadata })
    } else {
      if (metadata) {
        throw new Error('getting metadata is not yet supported outside of the API')
      }

      const normalizedAddress = address.toLowerCase()
      profile = await this._getProfileOrbit(normalizedAddress, opts)
    }
    return profile
  }

  /**
   * Get a list of public profiles for given addresses. This relies on 3Box profile API.
   *
   * @param     {Array}     address                 An array of ethereum addresses
   * @param     {Object}    opts                    Optional parameters
   * @param     {String}    opts.profileServer      URL of Profile API server
   * @return    {Object}                            a json object with each key an address and value the profile
   */
  static async getProfiles (addressArray, opts = {}) {
    return API.getProfiles(addressArray, opts)
  }

  /**
   * Get the public data in a space of a given address with the given name
   *
   * @param     {String}    address                 An ethereum address
   * @param     {String}    name                    A space name
   * @param     {Object}    opts                    Optional parameters
   * @param     {Function}  opts.blocklist          A function that takes an address and returns true if the user has been blocked
   * @param     {String}    opts.metadata           flag to retrieve metadata
   * @param     {String}    opts.profileServer      URL of Profile API server
   * @return    {Object}                            a json object with the public space data
   */
  static async getSpace (address, name, opts = {}) {
    return API.getSpace(address, name, opts.profileServer, opts)
  }

  /**
   * Get all posts that are made to a thread.
   *
   * @param     {String}    space                   The name of the space the thread is in
   * @param     {String}    name                    The name of the thread
   * @param     {String}    firstModerator          The DID (or ethereum address) of the first moderator
   * @param     {Boolean}   members                 True if only members are allowed to post
   * @param     {Object}    opts                    Optional parameters
   * @param     {String}    opts.profileServer      URL of Profile API server
   * @return    {Array<Object>}                     An array of posts
   */
  static async getThread (space, name, firstModerator, members, opts = {}) {
    return API.getThread(space, name, firstModerator, members, opts)
  }

  /**
   * Get all posts that are made to a thread.
   *
   * @param     {String}    address                 The orbitdb-address of the thread
   * @param     {Object}    opts                    Optional parameters
   * @param     {String}    opts.profileServer      URL of Profile API server
   * @return    {Array<Object>}                     An array of posts
   */
  static async getThreadByAddress (address, opts = {}) {
    return API.getThreadByAddress(address, opts)
  }

  /**
   * Get the configuration of a users 3Box
   *
   * @param     {String}    address                 The ethereum address
   * @param     {Object}    opts                    Optional parameters
   * @param     {String}    opts.profileServer      URL of Profile API server
   * @return    {Array<Object>}                     An array of posts
   */
  static async getConfig (address, opts = {}) {
    return API.getConfig(address, opts)
  }

  /**
   * Get the names of all spaces a user has
   *
   * @param     {String}    address                 An ethereum address
   * @param     {Object}    opts                    Optional parameters
   * @param     {String}    opts.profileServer      URL of Profile API server
   * @return    {Object}                            an array with all spaces as strings
   */
  static async listSpaces (address, opts = {}) {
    return API.listSpaces(address, opts.profileServer)
  }

  static async _getProfileOrbit (address, opts = {}) {
    // Removed this code since it's completely outdated.
    // TODO - implement using the replicator module
    throw new Error('Not implemented yet')
  }

  /**
   * GraphQL for 3Box profile API
   *
   * @param     {Object}    query               A graphQL query object.
   * @param     {Object}    opts                Optional parameters
   * @param     {String}    opts.graphqlServer  URL of graphQL 3Box profile service
   * @return    {Object}                        a json object with each key an address and value the profile
   */

  static async profileGraphQL (query, opts = {}) {
    return API.profileGraphQL(query, opts.graphqlServer)
  }

  /**
   * Verifies the proofs of social accounts that is present in the profile.
   *
   * @param     {Object}            profile                 A user profile object, received from the `getProfile` function
   * @return    {Object}                                    An object containing the accounts that have been verified
   */
  static async getVerifiedAccounts (profile) {
    return API.getVerifiedAccounts(profile)
  }

  /**
   * Opens the 3Box associated with the given address
   *
   * @param     {String}            address                 An ethereum address
   * @param     {provider}          provider                An ethereum or 3ID provider
   * @param     {Object}            opts                    Optional parameters
   * @param     {Function}          opts.consentCallback    A function that will be called when the user has consented to opening the box
   * @param     {String}            opts.pinningNode        A string with an ipfs multi-address to a 3box pinning node
   * @param     {Object}            opts.ipfs               A js-ipfs ipfs object
   * @param     {String}            opts.addressServer      URL of the Address Server
   * @param     {String}            opts.contentSignature   A signature, provided by a client of 3box using the private keys associated with the given address, of the 3box consent message
   * @return    {Box}                                       the 3Box instance for the given address
   */
  static async openBox (address, provider, opts = {}) {
    const ipfs = await Box.getIPFS(opts)
    if (typeof address === 'object' && address !== null) {
      // legacy support for IdentityWallet being passed in first param
      provider = address.get3idProvider()
    }
    const threeId = await ThreeId.getIdFromEthAddress(address, provider, ipfs, opts)
    const box = new Box(threeId, provider, ipfs, opts)
    await box._load(opts)
    return box
  }

  /**
   * Opens the space with the given name in the users 3Box
   *
   * @param     {String}            name                    The name of the space
   * @param     {Object}            opts                    Optional parameters
   * @param     {Function}          opts.consentCallback    A function that will be called when the user has consented to opening the box
   * @param     {Function}          opts.onSyncDone         A function that will be called when the space has finished syncing with the pinning node
   * @return    {Space}                                     the Space instance for the given space name
   */
  async openSpace (name, opts = {}) {
    if (!this.spaces[name]) {
      this.spaces[name] = new Space(name, this.replicator, this._3id)
      try {
        await this.spaces[name].open(opts)
        if (!await this.isAddressLinked()) this.linkAddress()
      } catch (e) {
        delete this.spaces[name]
        if (e.message.includes('User denied message signature.')) {
          throw new Error('User denied space consent.')
        } else {
          throw new Error('An error occured while opening space: ', e.message)
        }
      }
    } else if (opts.onSyncDone) {
      // since the space is already open we can call onSyncDone directly
      opts.onSyncDone()
    }
    return this.spaces[name]
  }

  /**
   * Sets the callback function that will be called once when the box is fully synced.
   *
   * @param     {Function}      syncDone        The function that will be called
   * @return    {Promise}                       A promise that is fulfilled when the box is syned
   */
  async onSyncDone (syncDone) {
    await this.syncDone
    syncDone()
  }

  async _publishRootStore (rootStoreAddress) {
    // Sign rootstoreAddress
    const addressToken = await this._3id.signJWT({ rootStoreAddress })
    // Store odbAddress on 3box-address-server
    try {
      await utils.fetchJson(this._serverUrl + '/odbAddress', {
        address_token: addressToken
      })
    } catch (err) {
      // we capture http errors (500, etc)
      // see: https://github.com/3box/3box-js/pull/351
      if (!err.statusCode) {
        throw new Error(err)
      }
    }
    return true
  }

  async _getRootstore (ethereumAddress) {
    try {
      const { rootStoreAddress } = (await utils.fetchJson(`${this._serverUrl}/odbAddress/${ethereumAddress}`)).data
      return rootStoreAddress
    } catch (err) {
      if (err.statusCode === 404) {
        return null
      }
      throw new Error('Error while getting rootstore', err)
    }
  }

  /**
   * @property {String} DID        the DID of the user
   */
  get DID () {
    return this._3id.muportDID
  }

  /**
   * Creates a proof that links an ethereum address to the 3Box account of the user. If given proof, it will simply be added to the root store.
   *
   * @param     {Object}    [link]                         Optional link object with type or proof
   * @param     {String}    [link.type='ethereum-eoa']     The type of link (default 'ethereum')
   * @param     {Object}    [link.proof]                   Proof object, should follow [spec](https://github.com/3box/3box/blob/master/3IPs/3ip-5.md)
   */
  async linkAddress (link = {}) {
    if (link.proof) {
      let valid
      if (link.proof.type === ACCOUNT_TYPES.ethereumEOA) {
        valid = await utils.recoverPersonalSign(link.proof.message, link.proof.signature)
      } else if (link.proof.type === ACCOUNT_TYPES.erc1271) {
        valid = await utils.isValidSignature(link.proof, true, this._web3provider)
      } else {
        throw new Error('Missing or invalid property "type" in proof')
      }
      if (!valid) {
        throw new Error('There was an issue verifying the supplied proof: ', valid)
      }
      await this._writeRootstoreEntry(Replicator.entryTypes.ADDRESS_LINK, link.proof)
      return
    }
    if (!link.type || link.type === ACCOUNT_TYPES.ethereumEOA) {
      await this._linkProfile()
    }
  }

  async linkAccount (type = ACCOUNT_TYPES.ethereumEOA) {
    console.warn('linkAccount: deprecated, please use linkAddress going forward')
    await this.linkAddress(type)
  }

  /**
   * Remove given address link, returns true if successful
   *
   * @param     {String}   address      address that is linked
   */
  async removeAddressLink (address) {
    address = address.toLowerCase()
    const linkExist = await this.isAddressLinked({ address })
    if (!linkExist) throw new Error('removeAddressLink: link for given address does not exist')
    const payload = {
      address,
      type: 'delete-address-link'
    }
    const oneHour = 60 * 60
    const deleteToken = await this._3id.signJWT(payload, { expiresIn: oneHour })

    try {
      await utils.fetchJson(this._serverUrl + '/linkdelete', {
        delete_token: deleteToken
      })
    } catch (err) {
      // we capture http errors (500, etc)
      // see: https://github.com/3box/3box-js/pull/351
      if (!err.statusCode) {
        throw new Error(err)
      }
    }

    await this._deleteAddressLink(address)

    return true
  }

  /**
   * Checks if there is a proof that links an external account to the 3Box account of the user. If not params given and any link exists, returns true
   *
   * @param     {Object}    [query]            Optional object with address and/or type.
   * @param     {String}    [query.type]       Does the given type of link exist
   * @param     {String}    [query.address]    Is the given adressed linked
   */
  async isAddressLinked (query = {}) {
    if (query.address) query.address = query.address.toLowerCase()
    const links = await this._readAddressLinks()
    const linksQuery = links.find(link => {
      const res = query.address ? link.address.toLowerCase() === query.address : true
      return query.type ? res && link.type === query.type : res
    })
    return Boolean(linksQuery)
  }

  async isAccountLinked (type = ACCOUNT_TYPES.ethereumEOA) {
    console.warn('isAccountLinked: deprecated, please use isAddressLinked going forward')
    return this.isAddressLinked(type)
  }

  /**
   * Lists address links associated with this 3Box
   *
   * @return    {Array}                        An array of link objects
   */
  async listAddressLinks () {
    const entries = await this._readAddressLinks()
    return entries.reduce((list, entry) => {
      const item = Object.assign({}, entry)
      item.linkId = item.entry.hash
      delete item.entry
      list.push(item)
      return list
    }, [])
  }

  async _linkProfile () {
    const address = await this._3id.getAddress()
    let linkData = await this._readAddressLink(address)

    if (!linkData) {
      const did = this.DID

      let consent
      try {
        // TODO - this should be handled in the 3ID class
        if (this._web3provider.is3idProvider) {
          consent = await utils.callRpc(this._web3provider, '3id_linkManagementKey', { did })
        } else {
          consent = await utils.getLinkConsent(address, did, this._web3provider)
        }
      } catch (e) {
        throw new Error('Link consent message must be signed before adding data, to link address to store')
      }

      const addressType = await this._detectAddressType(address)
      if (addressType === ACCOUNT_TYPES.erc1271) {
        const chainId = await utils.getChainId(this._web3provider)
        linkData = {
          version: 1,
          type: ACCOUNT_TYPES.erc1271,
          chainId,
          address,
          message: consent.msg,
          timestamp: consent.timestamp,
          signature: consent.sig
        }
      } else {
        linkData = {
          version: 1,
          type: ACCOUNT_TYPES.ethereumEOA,
          message: consent.msg,
          signature: consent.sig,
          timestamp: consent.timestamp
        }
      }
      try {
        await this._writeRootstoreEntry(Replicator.entryTypes.ADDRESS_LINK, linkData)
      } catch (err) {
        throw new Error('An error occured while publishing link:', err)
      }
    } else {
      // Send consentSignature to 3box-address-server to link profile with ethereum address
      // _writeAddressLink already does this if the other conditional is called
      if (!this.hasPublishedLink[linkData.signature]) {
        // Don't want to publish on every call to _linkProfile
        this.hasPublishedLink[linkData.signature] = true
        try {
          // Send consentSignature to 3box-address-server to link profile with ethereum address
          await utils.fetchJson(this._serverUrl + '/link', linkData)
        } catch (err) {
          throw new Error('An error occured while publishing link:', err)
        }
      }
    }
    // Ensure we self-published our did
    if (!(await this.public.get('proof_did'))) {
      // we can just sign an empty JWT as a proof that we own this DID
      await this.public.set('proof_did', await this._3id.signJWT(), { noLink: true })
    }
  }

  async _writeRootstoreEntry (type, payload) {
    const cid = (await this._ipfs.dag.put(payload)).toBaseEncodedString()
    await this._ipfs.pin.add(cid)
    const linkExist = await this._typeCIDExists(type, cid)
    if (linkExist) return
    const link = {
      type,
      data: cid
    }
    await this.replicator.rootstore.add(link)
    if (type === Replicator.entryTypes.ADDRESS_LINK) {
      await utils.fetchJson(this._serverUrl + '/link', payload)
    }
  }

  async _typeCIDExists (type, cid) {
    const entries = await this.replicator.rootstore.iterator({ limit: -1 }).collect()
    const typeEntries = entries.filter(e => e.payload.value.type === type)
    return Boolean(typeEntries.find(entry => entry.data === cid))
  }

  async _deleteAddressLink (address) {
    address = address.toLowerCase()
    const link = await this._readAddressLink(address)
    if (!link) throw new Error('_deleteAddressLink: link for given address does not exist')
    return this.replicator.rootstore.remove(link.entry.hash)
  }

  async _readAddressLinks () {
    const links = await this.replicator.getAddressLinks()
    const allLinks = await Promise.all(links.map(async linkObj => {
      if (!linkObj.address) {
        linkObj.address = utils.recoverPersonalSign(linkObj.message, linkObj.signature)
      }
      const isErc1271 = linkObj.type === ACCOUNT_TYPES.erc1271
      if (!(await utils.isValidSignature(linkObj, isErc1271, this._web3provider))) {
        return null
      }
      return linkObj
    }))
    return allLinks.filter(Boolean)
  }

  async _readAddressLink (address) {
    address = address.toLowerCase()
    const links = await this._readAddressLinks()
    return links.find(link => link.address.toLowerCase() === address)
  }

  async _detectAddressType (address) {
    try {
      const bytecode = await utils.getCode(this._web3provider, address).catch(() => null)
      if (!bytecode || bytecode === '0x' || bytecode === '0x0' || bytecode === '0x00') {
        return ACCOUNT_TYPES.ethereumEOA
      }
      return ACCOUNT_TYPES.erc1271
    } catch (e) {
      // Throws an error assume the provider is a 3id provider only
      return ACCOUNT_TYPES.ethereumEOA
    }
  }

  async close () {
    await this.replicator.stop()
  }

  /**
   * Closes the 3box instance and clears local cache. If you call this,
   * users will need to sign a consent message to log in the next time
   * you call openBox.
   */
  async logout () {
    await this.close()
    this._3id.logout()
    const address = await this._3id.getAddress()
    localstorage.remove('linkConsent_' + address)
  }

  /**
   * Check if the given address is logged in
   *
   * @param     {String}    address                 An ethereum address
   * @return    {Boolean}                           true if the user is logged in
   */
  static isLoggedIn (address) {
    return ThreeId.isLoggedIn(address)
  }

  /**
   * Instanciate ipfs used by 3Box without calling openBox.
   *
   * @return    {IPFS}                           the ipfs instance
   */
  static async getIPFS (opts = {}) {
    const ipfs = globalIPFS || await initIPFS(opts.ipfs, opts.iframeStore, opts.ipfsOptions)
    globalIPFS = ipfs
    const pinningNode = opts.pinningNode || PINNING_NODE
    ipfs.swarm.connect(pinningNode, () => {})
    return ipfs
  }
}

function initIPFSRepo () {
  let repoOpts = {}
  let ipfsRootPath

  // if in browser, create unique root storage, and ipfs id on each instance
  if (typeof window !== 'undefined' && window.indexedDB) {
    const sessionID = utils.randInt(10000)
    ipfsRootPath = 'ipfs/root/' + sessionID
    const levelInstance = new LevelStore(ipfsRootPath)
    repoOpts = { storageBackends: { root: () => levelInstance } }
  }

  const repo = new IPFSRepo('ipfs', repoOpts)

  return {
    repo,
    rootPath: ipfsRootPath
  }
}

async function initIPFS (ipfs, iframeStore, ipfsOptions) {
  // if (!ipfs && !ipfsProxy) throw new Error('No IPFS object configured and no default available for environment')
  if (!!ipfs && iframeStore) console.log('Warning: iframeStore true, orbit db cache in iframe, but the given ipfs object is being used, and may not be running in same iframe.')
  if (ipfs) {
    return ipfs
  } else {
    // await iframeLoadedPromise
    // return ipfsProxy
    let ipfsRepo
    if (!ipfsOptions) {
      ipfsRepo = initIPFSRepo()
      ipfsOptions = Object.assign(IPFS_OPTIONS, { repo: ipfsRepo.repo })
    }
    return new Promise((resolve, reject) => {
      ipfs = new IPFS(ipfsOptions)
      ipfs.on('error', error => {
        console.error(error)
        reject(error)
      })
      ipfs.on('ready', () => {
        resolve(ipfs)
        if (ipfsRepo && typeof window !== 'undefined' && window.indexedDB) {
          // deletes once db is closed again
          window.indexedDB.deleteDatabase(ipfsRepo.rootPath)
        }
      })
    })
  }
}

Box.idUtils = idUtils

module.exports = Box
