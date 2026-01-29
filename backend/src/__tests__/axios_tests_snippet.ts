
  describe('Streamable Http Custom Fetch (Axios Adapter)', () => {
    beforeEach(() => {
      mockAxios.mockReset();
      mockAxios.mockResolvedValue({
        data: Buffer.from('test data'),
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
      (settingsService.getSetting as jest.Mock).mockResolvedValue(null);
    });

    it('should inject custom fetch into transport', async () => {
      Object.assign(internalMcpServers, {
        'http-server': { transport: 'streamable-http', url: 'http://test.example.com' }
      });

      const mockClient = {
        connect: jest.fn().mockResolvedValue(undefined),
        listTools: jest.fn().mockResolvedValue({ tools: [] }),
        close: jest.fn()
      };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(StreamableHTTPClientTransport).toHaveBeenCalled();
      const options = (StreamableHTTPClientTransport as jest.Mock).mock.calls[0][1];
      expect(options).toHaveProperty('fetch');
      expect(typeof options.fetch).toBe('function');
    });

    it('should sanitize headers and set infinite timeout', async () => {
      Object.assign(internalMcpServers, {
        'http-server': { transport: 'streamable-http', url: 'http://test.example.com' }
      });

      // Capture the custom fetch function
      let capturedFetch: any;
      (StreamableHTTPClientTransport as jest.Mock).mockImplementation((url, opts) => {
        capturedFetch = opts?.fetch;
        return { onclose: null, onerror: null };
      });

      const mockClient = { connect: jest.fn(), listTools: jest.fn(), close: jest.fn() };
      (Client as jest.Mock).mockImplementation(() => mockClient);

      await service.initialize();

      expect(capturedFetch).toBeDefined();

      // Invoke the custom fetch with various messy headers
      const dirtyHeaders = {
        'Content-Length': 123, // Number
        'X-Nullable': null,    // Null
        'X-Undefined': undefined, // Undefined
        'X-String': 'valid'    // String
      };

      await capturedFetch('http://test.example.com', {
        method: 'POST',
        headers: dirtyHeaders,
        body: 'test'
      });

      // Verify axios call arguments
      expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({
        url: 'http://test.example.com',
        method: 'POST',
        timeout: 0, // CRITICAL VERIFICATION
        headers: expect.objectContaining({
            'Content-Length': '123', // Should be stringified
            'X-String': 'valid'
        })
      }));

      // Null/Undefined should be filtered out or handled safely (implementation specific)
      // Our implementation filters them out in the Object.entries loop
      const callArgs = mockAxios.mock.calls[0][0];
      expect(callArgs.headers).not.toHaveProperty('X-Nullable');
      expect(callArgs.headers).not.toHaveProperty('X-Undefined');
    });

    it('should handle Headers object correctly', async () => {
       Object.assign(internalMcpServers, { 'http-server': { transport: 'streamable-http', url: 'http://test.example.com' } });
       
       let capturedFetch: any;
       (StreamableHTTPClientTransport as jest.Mock).mockImplementation((url, opts) => {
         capturedFetch = opts?.fetch;
         return { onclose: null, onerror: null };
       });
       (Client as jest.Mock).mockImplementation(() => ({ connect: jest.fn(), listTools: jest.fn(), close: jest.fn() }));

       await service.initialize();

       const headersObj = new Headers();
       headersObj.set('X-Custom', 'value');
       
       await capturedFetch('http://test.example.com', { headers: headersObj });

       expect(mockAxios).toHaveBeenCalledWith(expect.objectContaining({
          headers: expect.objectContaining({ 'X-Custom': 'value' })
       }));
    });
  });
