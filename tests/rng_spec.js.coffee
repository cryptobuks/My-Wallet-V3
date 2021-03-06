proxyquire = require('proxyquireify')(require);

RNG   = proxyquire('../src/rng', {})

describe "RNG", ->

  serverBuffer = new Buffer(
    "0000000000000000000000000000000000000000000000000000000000000010",
    "hex"
  )

  longServerBuffer = new Buffer(
    "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010",
    "hex"
  )

  zerosServerBuffer = new Buffer(
    "0000000000000000000000000000000000000000000000000000000000000000",
    "hex"
  )

  shortServerBuffer = new Buffer(
    "0000000000000000000000000000000001",
    "hex"
  )

  xorBuffer = new Buffer(
    "0000000000000000000000000000000000000000000000000000000000000011",
    "hex"
  )

  xorFailingServerBuffer = new Buffer(
    "0000000000000000000000000000000000000000000000000000000000000001",
    "hex"
  )

  describe ".xor()", ->

    it "should be an xor operation", ->
      A = new Buffer('a123456c', 'hex')
      B = new Buffer('ff0123cd', 'hex')
      R = '5e2266a1'
      expect(RNG.xor(A,B).toString('hex')).toEqual(R)

    it "should return the shortest common length", ->
      A = new Buffer('a123'    , 'hex')
      B = new Buffer('ff0123cd', 'hex')
      R = '5e22'
      expect(RNG.xor(A,B).toString('hex')).toEqual(R)

  describe ".run()", ->
    browser = {
      lastBit: 1
    }

    beforeEach ->
      window.crypto.getRandomValues = (array) ->
        array[31] = browser.lastBit
        return

      spyOn(console, "log").and.callFake(() -> )

    it "should ask for 32 bytes from the server", ->
      spyOn(RNG, "getServerEntropy").and.callFake(
        (bytes) ->
          expect(bytes).toEqual(32)
          serverBuffer
      )
      RNG.run()

    it "should ask an arbitrary amount of bytes from the server", ->
      spyOn(RNG, "getServerEntropy").and.callFake(
        (bytes) ->
          expect(bytes).toEqual(64)
          longServerBuffer
      )

      RNG.run(64)

    it "returns the mixed entropy", ->
      spyOn(RNG, "getServerEntropy").and.callFake(
        (bytes) ->
          serverBuffer
      )

      expect(RNG.run().toString("hex")).toEqual(xorBuffer.toString("hex"))

    it "fails if server data is all zeros", ->
      spyOn(RNG, "getServerEntropy").and.callFake(
        (bytes) ->
          zerosServerBuffer
      )
      expect(() -> RNG.run()).toThrow()

    it "fails if browser data is all zeros", ->
      spyOn(RNG, "getServerEntropy").and.callFake(
        (bytes) ->
          serverBuffer
      )
      browser.lastBit = 0
      expect(() -> RNG.run()).toThrow()
      browser.lastBit = 1

    it "fails if server data has the wrong length", ->
      spyOn(RNG, "getServerEntropy").and.callFake(
        (bytes) ->
          shortServerBuffer
      )
      expect(() -> RNG.run()).toThrow()

    it "fails if combined entropy is all zeros", ->
      spyOn(RNG, "getServerEntropy").and.callFake(
        (bytes) ->
          xorFailingServerBuffer
      )
      expect(() -> RNG.run()).toThrow()

  describe ".getServerEntropy()", ->
    mock =
      responseText: "0000000000000000000000000000000000000000000000000000000000000010"
      statusCode: 200

    request =
      open: () ->
      setRequestHeader: () ->
      send: () ->
        this.status = mock.statusCode
        this.responseText = mock.responseText

    beforeEach ->
      spyOn(window, "XMLHttpRequest").and.returnValue request
      spyOn(request, "open").and.callThrough()

    it "makes a GET request to the backend", ->
      RNG.getServerEntropy(32)
      expect(request.open).toHaveBeenCalled()
      expect(request.open.calls.argsFor(0)[0]).toEqual("GET")
      expect(request.open.calls.argsFor(0)[1]).toContain("v2/randombytes")

    it "returns a buffer is successful", ->
      res = RNG.getServerEntropy(32)
      expect(Buffer.isBuffer(res)).toBeTruthy()

    it "returns a 32 bytes buffer if nBytes not indicated and if is successful", ->
      res = RNG.getServerEntropy()
      expect(Buffer.isBuffer(res)).toBeTruthy()
      expect(res.length).toEqual(32)

    it "throws an exception if result is not hex", ->
      mock.responseText = "This page was not found"
      expect(() -> RNG.getServerEntropy(32)).toThrow()

    it "throws an exception if result is the wrong length", ->
      mock.responseText = "000001"
      expect(() -> RNG.getServerEntropy(3)).not.toThrow()
      expect(() -> RNG.getServerEntropy(32)).toThrow()

    it "throws an exception if the server does not return a 200", ->
      mock.statusCode = 500
      expect(() -> RNG.getServerEntropy(32)).toThrow()
