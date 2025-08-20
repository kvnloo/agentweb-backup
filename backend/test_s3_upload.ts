import AWS from "aws-sdk";
import axios from "axios";
import * as dotenv from "dotenv";
import path from "path";

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, ".env") });

// Configure AWS
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || "us-east-1",
});

const s3 = new AWS.S3();

async function testS3Upload() {
  try {
    console.log("🧪 Testing S3 upload functionality...");

    // Check environment variables
    const requiredEnvVars = [
      "S3_BUCKET_NAME",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ];
    const missingVars = requiredEnvVars.filter(
      (varName) => !process.env[varName]
    );

    if (missingVars.length > 0) {
      console.error("❌ Missing environment variables:", missingVars);
      console.log("Please set these in your .env file");
      console.log("Current .env path:", path.join(__dirname, ".env"));
      console.log(
        "Available env vars:",
        Object.keys(process.env).filter(
          (key) => key.includes("AWS") || key.includes("S3")
        )
      );
      return;
    }

    console.log("✅ Environment variables configured");
    console.log("📦 S3 Bucket:", process.env.S3_BUCKET_NAME);
    console.log("🌍 AWS Region:", process.env.AWS_REGION || "us-east-1");

    // Test bucket access
    try {
      await s3.headBucket({ Bucket: process.env.S3_BUCKET_NAME! }).promise();
      console.log("✅ S3 bucket access confirmed");
    } catch (error: any) {
      console.error("❌ Cannot access S3 bucket:", error.message);
      return;
    }

    // Test with a simple placeholder image
    console.log("🖼️ Testing image upload...");

    // Download a test image from Picsum
    const testImageUrl = "https://picsum.photos/200/200?random=1";
    const response = await axios.get(testImageUrl, {
      responseType: "arraybuffer",
    });
    const imageBuffer = Buffer.from(response.data as ArrayBuffer);

    // Upload to S3
    const testKey = `test-upload-${Date.now()}.jpg`;
    const uploadResult = await s3
      .upload({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: testKey,
        Body: imageBuffer,
        ContentType: "image/jpeg",
      })
      .promise();

    console.log("✅ Test image uploaded successfully!");
    console.log("🔗 S3 URL:", uploadResult.Location);
    console.log("📁 S3 Key:", testKey);

    // Test public access
    try {
      const publicResponse = await axios.head(uploadResult.Location);
      console.log(
        "✅ Public access confirmed (HTTP Status:",
        publicResponse.status,
        ")"
      );
    } catch (error: any) {
      console.warn("⚠️ Public access test failed:", error.message);
    }

    // Clean up test file
    try {
      await s3
        .deleteObject({
          Bucket: process.env.S3_BUCKET_NAME!,
          Key: testKey,
        })
        .promise();
      console.log("🧹 Test file cleaned up");
    } catch (error: any) {
      console.warn("⚠️ Could not clean up test file:", error.message);
    }

    console.log("🎉 S3 upload test completed successfully!");
  } catch (error: any) {
    console.error("❌ S3 upload test failed:", error.message);
    console.error("Full error:", error);
  }
}

// Run the test
testS3Upload();
