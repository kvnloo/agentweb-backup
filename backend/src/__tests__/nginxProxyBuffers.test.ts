import fs from "fs";
import path from "path";

const parseSizeKb = (value: string): number => {
  const match = value.trim().match(/^(\d+)([kKmM])$/);
  if (!match) {
    throw new Error(`Unsupported nginx size value: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  return unit === "m" ? amount * 1024 : amount;
};

describe("Elastic Beanstalk nginx proxy buffering", () => {
  it("keeps admin-sized JSON responses out of disk temp files", () => {
    const config = fs.readFileSync(
      path.join(process.cwd(), ".platform/nginx/conf.d/proxy_buffers.conf"),
      "utf8"
    );

    const buffersMatch = config.match(/^\s*proxy_buffers\s+(\d+)\s+(\S+);/m);
    expect(buffersMatch).not.toBeNull();

    const bufferCount = Number(buffersMatch![1]);
    const bufferSizeKb = parseSizeKb(buffersMatch![2]);
    const totalBufferKb = bufferCount * bufferSizeKb;

    expect(totalBufferKb).toBeGreaterThanOrEqual(2048);
    expect(config).toMatch(/^\s*proxy_max_temp_file_size\s+0;/m);
  });
});
