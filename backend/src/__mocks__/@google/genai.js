// Manual mock for @google/genai module (CommonJS format)
module.exports = {
  GoogleGenAI: jest.fn().mockImplementation(() => ({
    models: {
      generateContentStream: jest.fn()
    }
  }))
};

