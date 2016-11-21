'use strict';

var WalletCrypto = require('./wallet-crypto');
var Bitcoin = require('bitcoinjs-lib');
var crypto = require('crypto');
var API = require('./api');
var MyWallet = require('./wallet');
var Contacts = require('./contacts');

module.exports = SharedMetadata;

function SharedMetadata (cipher) {
  // BIP 43 purpose needs to be 31 bit or less. For lack of a BIP number
  // we take the first 31 bits of the SHA256 hash of a reverse domain.
  var hash = WalletCrypto.sha256('info.blockchain.mdid');
  var purpose = hash.slice(0, 4).readUInt32BE(0) & 0x7FFFFFFF;
  var masterHDNode = MyWallet.wallet.hdwallet.getMasterHDNode(cipher);
  var mdidHDNode = masterHDNode.deriveHardened(purpose);
  this._node = mdidHDNode;
  this._xpub = mdidHDNode.neutered().toBase58();
  this._priv = mdidHDNode.toBase58();
  this._mdid = mdidHDNode.getAddress();
  this._keyPair = mdidHDNode.keyPair;
  this._auth_token = undefined;
  this.getToken();
  this.contacts = new Contacts();
  this.contacts.fetch();
}

Object.defineProperties(SharedMetadata.prototype, {
  'mdid': {
    configurable: false,
    get: function () { return this._mdid; }
  },
  'priv': {
    configurable: false,
    get: function () { return this._priv; }
  }
});

SharedMetadata.prototype.sign = function (message) {
  return Bitcoin.message.sign(this._keyPair, message).toString('base64');
};

SharedMetadata.prototype.verify = function (message, signature, mdid) {
  return Bitcoin.message.verify (mdid, signature, message);
}

SharedMetadata.prototype.request = function (method, endpoint, data) {
  var url = API.API_ROOT_URL + 'metadata/' + endpoint;
  var options = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + this._auth_token
    },
    credentials: 'omit'
  };

  // encodeFormData :: Object -> url encoded params
  var encodeFormData = function (data) {
    if (!data) return '';
    var encoded = Object.keys(data).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(data[k]);
    }).join('&');
    return encoded ? '?' + encoded : encoded;
  };

  if (data && data !== {}) {
    if (method === 'GET') {
      url += encodeFormData(data);
    } else {
      options.body = JSON.stringify(data);
    }
  }

  options.method = method;

  var handleNetworkError = function (e) {
    return Promise.reject({ error: 'SHARED_METADATA_CONNECT_ERROR', message: e });
  };

  var checkStatus = function (response) {
    if (response.ok) {
      return response.json();
    } else {
      return response.text().then(Promise.reject.bind(Promise));
    }
  };

  return fetch(url, options)
    .catch(handleNetworkError)
    .then(checkStatus);
};

SharedMetadata.prototype.getToken = function () {
  return this.request('GET','auth')
             .then( (r) => ({nonce: r.nonce, signature: this.sign(r.nonce), mdid: this._mdid}) )
             .then( (d) => this.request('POST', 'auth' , d))
             .then( (r) => { this._auth_token = r.token; return r.token});
};

SharedMetadata.prototype.getMessages = function (from) {
  var getParams = {};
  if (from != undefined) getParams.from = from;
  return this.request('GET', 'messages', getParams);
};

SharedMetadata.prototype.getMessage = function (id) {
  return this.request('GET', 'message/' + id);
};

SharedMetadata.prototype.processMessage = function (msgId) {
  return this.request('PATCH', 'message/' + msgId);
};

SharedMetadata.prototype.addContact = function (contactMdid) {
  return this.request('PUT', 'trusted/' + contactMdid);
};

SharedMetadata.prototype.getContacts = function () {
  return this.request('GET', 'trusted');
};

SharedMetadata.prototype.getContact = function (contactMdid) {
  return this.request('GET', 'trusted/' + contactMdid);
};

SharedMetadata.prototype.removeContact = function (contactMdid) {
  return this.request('DELETE', 'trusted/' + contactMdid);
};

SharedMetadata.prototype.sendMessage = function (mdidRecipient, payload, type) {
  var encrypted = this.encryptFor(payload, mdidRecipient);
  var body = {
    type: type,
    payload: encrypted,
    signature: this.sign(encrypted),
    // sender: this.mdid,
    recipient: mdidRecipient
  };
  return this.request('POST', 'messages', body);
};

SharedMetadata.prototype.readMessage = function (msg) {
  // TODO :: The public key can be extracted from the signature
  return this.verify(msg.payload, msg.signature, msg.sender)
    ? Promise.resolve(this.decryptFrom(msg.payload, msg.sender))
    : Promise.reject('Wrong Signature');
};

SharedMetadata.prototype.encryptFor = function (message, mdid) {
  var contactObject = this.contacts.get(mdid);
  var contactPublicKey = Contacts.toPubKey(contactObject);
  var sharedSecret = contactPublicKey.Q.multiply(this._keyPair.d).getEncoded(true);
  var sharedKey = WalletCrypto.sha256(sharedSecret);
  return WalletCrypto.encryptDataWithKey(message, sharedKey);
};

SharedMetadata.prototype.decryptFrom = function (message, mdid) {
  var contactObject = this.contacts.get(mdid);
  var contactPublicKey = Contacts.toPubKey(contactObject);
  var sharedSecret = contactPublicKey.Q.multiply(this._keyPair.d).getEncoded(true);
  var sharedKey = WalletCrypto.sha256(sharedSecret);
  return WalletCrypto.decryptDataWithKey(message, sharedKey);
};

SharedMetadata.prototype.sendPaymentRequest = function (mdid, amount, note) {
  // type 1 :: paymentRequest
  var paymentRequest = {
    amount: amount,
    note: note
  };
  return this.sendMessage(mdid, JSON.stringify(paymentRequest), 1);
};

SharedMetadata.prototype.sendPaymentRequestResponse = function (requestMessage) {
  // type 2 :: payment request answer
  var msgP = this.readMessage(requestMessage);
  var f = function (msg) {
    var requestResponse = {
      address: MyWallet.wallet.hdwallet.defaultAccount.receiveAddress,
      amount: msg.amount,
      note: msg.note
    };
    return this.sendMessage(requestMessage.sender, JSON.stringify(requestResponse), 2);
  };
  return msgP.then(f.bind(this));
};

// createInvitation :: Promise InvitationID
SharedMetadata.prototype.createInvitation = function () {
  return this.request('POST', 'share');
};

// readInvitation :: String -> Promise RequesterID
SharedMetadata.prototype.readInvitation = function (id) {
  return this.request('GET', 'share/' + id);
};

// acceptInvitation :: String -> Promise ()
SharedMetadata.prototype.acceptInvitation = function (id) {
  return this.request('POST', 'share/' + id);
};

// deleteInvitation :: String -> Promise ()
SharedMetadata.prototype.deleteInvitation = function (id) {
  return this.request('DELETE', 'share/' + id);
};