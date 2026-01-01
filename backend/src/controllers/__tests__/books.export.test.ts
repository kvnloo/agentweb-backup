import { Response } from "express";
import { AuthenticatedRequest } from "../../middleware/auth";
import { exportBook } from "../books";

jest.mock("pdfkit", () => {
  const instances: any[] = [];

  class MockPDFDocument {
    options: any;
    page: any;
    x: number;
    y: number;
    _events: Record<string, (...args: any[]) => void>;
    _fontSize: number;
    __textCalls: Array<{ text: string; options?: any }>;

    constructor(options: any = {}) {
      this.options = options;
      this.page = {
        width: 612,
        height: 792,
        margins: options.margins ?? { top: 72, bottom: 72, left: 72, right: 72 },
      };
      this.x = this.page.margins.left;
      this.y = this.page.margins.top;
      this._events = {};
      this._fontSize = 12;
      this.__textCalls = [];
      instances.push(this);
    }

    on(event: string, handler: (...args: any[]) => void) {
      this._events[event] = handler;
      return this;
    }

    registerFont() {
      return this;
    }

    font() {
      return this;
    }

    fontSize(size?: number) {
      if (typeof size === "number") {
        this._fontSize = size;
      }
      return this;
    }

    fillColor() {
      return this;
    }

    text(text: string, xOrOptions?: any, yOrOptions?: any, options?: any) {
      const opts = typeof xOrOptions === "number" ? options : xOrOptions;
      this.__textCalls.push({ text, options: opts });
      if (!opts?.continued) {
        const lineGap = opts?.lineGap ?? 0;
        this.y += this._fontSize + lineGap;
      }
      return this;
    }

    moveDown(lines: number = 1) {
      this.y += this._fontSize * lines;
      return this;
    }

    addPage() {
      this.x = this.page.margins.left;
      this.y = this.page.margins.top;
      return this;
    }

    image() {
      return this;
    }

    save() {
      return this;
    }

    restore() {
      return this;
    }

    moveTo() {
      return this;
    }

    lineTo() {
      return this;
    }

    lineWidth() {
      return this;
    }

    strokeColor() {
      return this;
    }

    stroke() {
      return this;
    }

    end() {
      const dataHandler = this._events.data;
      const endHandler = this._events.end;
      if (dataHandler) {
        dataHandler(Buffer.from("PDF"));
      }
      if (endHandler) {
        endHandler();
      }
    }
  }

  const mockModule: any = MockPDFDocument;
  mockModule.__esModule = true;
  mockModule.default = MockPDFDocument;
  mockModule.__getPdfDocInstances = () => instances;
  mockModule.__resetPdfDocInstances = () => {
    instances.length = 0;
  };
  return mockModule;
});

jest.mock("aws-sdk", () => {
  const mockPutObject = jest.fn().mockReturnValue({
    promise: jest.fn().mockResolvedValue({}),
  });

  return {
    S3: jest.fn().mockImplementation(() => ({
      putObject: mockPutObject,
    })),
    __mockPutObject: mockPutObject,
  };
});

jest.mock("../../services/bookDb", () => ({
  bookDb: {
    getBookById: jest.fn(),
    updateBook: jest.fn(),
  },
}));

jest.mock("../../services/bookContentDb", () => ({
  bookContentDb: {
    getAllBookContents: jest.fn(),
  },
}));

jest.mock("uuid", () => ({
  v4: jest.fn(() => "uuid-123"),
}));

const { bookDb } = jest.requireMock("../../services/bookDb");
const { bookContentDb } = jest.requireMock("../../services/bookContentDb");
const { __mockPutObject: mockPutObject } = jest.requireMock("aws-sdk");

const mockRequest = (
  overrides: Partial<AuthenticatedRequest> = {}
): Partial<AuthenticatedRequest> => ({
  params: {},
  body: {},
  user: { userId: "user-1", email: "user@example.com", isAdmin: false },
  ...overrides,
});

const mockResponse = (): Partial<Response> => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe("exportBook", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const { __resetPdfDocInstances } = jest.requireMock("pdfkit");
    __resetPdfDocInstances();
  });

  it("returns 401 when userId is missing", async () => {
    const req = mockRequest({ user: undefined });
    const res = mockResponse();

    await exportBook(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "User ID not provided" });
  });

  it("returns 400 when bookId is missing", async () => {
    const req = mockRequest({ params: {} });
    const res = mockResponse();

    await exportBook(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Book ID is required" });
  });

  it("returns 404 when book does not exist", async () => {
    (bookDb.getBookById as jest.Mock).mockResolvedValue(null);

    const req = mockRequest({ params: { bookId: "book-1" } });
    const res = mockResponse();

    await exportBook(req as AuthenticatedRequest, res as Response);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Book not found" });
  });

  it("exports TXT and uploads to S3", async () => {
    (bookDb.getBookById as jest.Mock).mockResolvedValue({
      bookId: "book-1",
      userId: "user-1",
      title: "Book Title",
      type: "book",
      exports: [],
      sections: [],
    });
    (bookContentDb.getAllBookContents as jest.Mock).mockResolvedValue([]);
    (bookDb.updateBook as jest.Mock).mockResolvedValue({
      bookId: "book-1",
      exports: [{ exportId: "uuid-123", format: "txt" }],
    });

    const req = mockRequest({
      params: { bookId: "book-1" },
      body: { exportConfig: { format: "txt" } },
    });
    const res = mockResponse();

    await exportBook(req as AuthenticatedRequest, res as Response);

    expect(mockPutObject).toHaveBeenCalledWith(
      expect.objectContaining({
        ContentType: "text/plain; charset=utf-8",
        Key: expect.stringContaining(".txt"),
      })
    );
    expect(bookDb.updateBook).toHaveBeenCalledWith("book-1", "user-1", {
      exports: expect.any(Array),
    });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          export: expect.objectContaining({ format: "txt" }),
        }),
      })
    );
  });

  it("finalizes bold-only paragraphs to avoid PDF overlap", async () => {
    const mockedTokens = [
      {
        type: "paragraph",
        tokens: [
          {
            type: "strong",
            text: "Core Capabilities:",
            tokens: [{ type: "text", text: "Core Capabilities:" }],
          },
        ],
      },
      {
        type: "list",
        ordered: false,
        items: [
          {
            text: "Graph-based workflow API supporting sequential, parallel, and hierarchical orchestration patterns [2, 9]",
            tokens: [
              {
                type: "text",
                text: "Graph-based workflow API supporting sequential, parallel, and hierarchical orchestration patterns [2, 9]",
              },
            ],
          },
        ],
      },
    ];
    const mockMarkedModule = {
      marked: {
        lexer: jest.fn(() => mockedTokens),
      },
    };
    const originalFunction = global.Function;
    const functionShim = function (...args: any[]) {
      if (args[0] === "specifier" && args[1] === "return import(specifier)") {
        return (specifier: string) => {
          if (specifier === "marked") {
            return Promise.resolve(mockMarkedModule);
          }
          return (originalFunction as any)("specifier", "return import(specifier)")(
            specifier
          );
        };
      }
      return (originalFunction as any)(...args);
    } as any;
    functionShim.prototype = originalFunction.prototype;
    (global as any).Function = functionShim;

    (bookDb.getBookById as jest.Mock).mockResolvedValue({
      bookId: "book-1",
      userId: "user-1",
      title: "Book Title",
      type: "book",
      exports: [],
      sections: [
        {
          sectionId: "section-1",
          title: "Overview",
          order: 1,
          chapters: [],
        },
      ],
    });
    (bookContentDb.getAllBookContents as jest.Mock).mockResolvedValue([
      {
        sectionId: "section-1",
        chapterId: undefined,
        content:
          "**Core Capabilities:**\n- Graph-based workflow API supporting sequential, parallel, and hierarchical orchestration patterns [2, 9]\n- Thread-based state management with OpenTelemetry integration for production observability [9]",
      },
    ]);
    (bookDb.updateBook as jest.Mock).mockResolvedValue({
      bookId: "book-1",
      exports: [{ exportId: "uuid-123", format: "pdf" }],
    });

    const req = mockRequest({
      params: { bookId: "book-1" },
      body: { exportConfig: { format: "pdf" } },
    });
    const res = mockResponse();

    try {
      await exportBook(req as AuthenticatedRequest, res as Response);
    } finally {
      (global as any).Function = originalFunction;
    }

    const { __getPdfDocInstances } = jest.requireMock("pdfkit");
    const instances = __getPdfDocInstances();
    const textCalls = instances.flatMap((instance: any) => instance.__textCalls || []);
    const boldCall = textCalls.find((call: any) =>
      String(call.text).includes("Core Capabilities:")
    );

    expect(instances.length).toBeGreaterThan(0);
    expect(boldCall).toBeDefined();
    expect(boldCall.options?.continued).toBe(false);
  });
});
