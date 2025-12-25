import { Request, Response } from "express";
import { exportBook } from "../books";

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

const mockRequest = (overrides: Partial<Request> = {}): Partial<Request> => ({
  params: {},
  body: {},
  user: { userId: "user-1", email: "user@example.com" },
  ...overrides,
});

const mockResponse = (): Partial<Response> => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn().mockReturnThis(),
});

describe("exportBook", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 401 when userId is missing", async () => {
    const req = mockRequest({ user: undefined });
    const res = mockResponse();

    await exportBook(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "User ID not provided" });
  });

  it("returns 400 when bookId is missing", async () => {
    const req = mockRequest({ params: {} });
    const res = mockResponse();

    await exportBook(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Book ID is required" });
  });

  it("returns 404 when book does not exist", async () => {
    (bookDb.getBookById as jest.Mock).mockResolvedValue(null);

    const req = mockRequest({ params: { bookId: "book-1" } });
    const res = mockResponse();

    await exportBook(req as Request, res as Response);

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

    await exportBook(req as Request, res as Response);

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
});
