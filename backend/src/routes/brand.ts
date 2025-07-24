import { Router } from "express";
import { authenticateToken, AuthenticatedRequest } from "../middleware/auth";
import { DynamoDB } from "aws-sdk";
import { v4 as uuidv4 } from "uuid";
import multer from "multer";
import { S3 } from "aws-sdk";
import crypto from "crypto";

const router = Router();
const dynamodb = new DynamoDB.DocumentClient();
const s3 = new S3();

// Get table prefix based on NODE_ENV
const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

// Helper function to upload file to S3
async function uploadBrandFile(
  file: Express.Multer.File,
  userId: string,
  fileType: string
): Promise<{ url: string; key: string }> {
  const randomToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const key = `users/${userId}/brand/${fileType}/${Date.now()}-${randomToken}-${
    file.originalname
  }`;

  await s3
    .putObject({
      Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    })
    .promise();

  const url = `https://${
    process.env.AWS_S3_BUCKET || "agentweb-user-files"
  }.s3.${process.env.AWS_REGION || "us-west-2"}.amazonaws.com/${key}`;

  return { url, key };
}

// Get user's brand guidelines
router.get("/guidelines", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    const result = await dynamodb
      .query({
        TableName: `${TABLE_PREFIX}AW-Users`,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
      })
      .promise();

    const users = result.Items || [];

    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = users[0];
    const brandGuidelines = user.brandGuidelines;

    if (!brandGuidelines) {
      return res.json({
        exists: false,
        message: "No brand guidelines found",
      });
    }

    res.json({
      exists: true,
      brandData: brandGuidelines.brandData || {},
      attachments: brandGuidelines.attachments || [],
      createdAt: brandGuidelines.createdAt,
      updatedAt: brandGuidelines.updatedAt,
    });
  } catch (error) {
    console.error("Error fetching brand guidelines:", error);
    res.status(500).json({ error: "Failed to fetch brand guidelines" });
  }
});

// Create or update brand guidelines
router.post(
  "/guidelines",
  authenticateToken,
  upload.fields([
    { name: "logo", maxCount: 1 },
    { name: "secondaryLogo", maxCount: 1 },
    { name: "brandGuide", maxCount: 1 },
    { name: "additionalAssets", maxCount: 10 },
  ]),
  async (req, res) => {
    try {
      const userId = (req as AuthenticatedRequest).user?.userId;
      if (!userId) {
        return res.status(401).json({ error: "User ID not provided" });
      }

      const {
        primaryColor,
        secondaryColor,
        fontFamily,
        toneOfVoice,
        keyMessages,
        brandName,
        tagline,
        brandValues,
        targetAudience,
        brandPersonality,
      } = req.body;

      const files = req.files as { [fieldname: string]: Express.Multer.File[] };

      // Upload files to S3
      const attachments = [];

      if (files.logo && files.logo[0]) {
        const { url, key } = await uploadBrandFile(
          files.logo[0],
          userId,
          "logo"
        );
        attachments.push({
          type: "logo",
          url,
          key,
          filename: files.logo[0].originalname,
        });
      }

      if (files.secondaryLogo && files.secondaryLogo[0]) {
        const { url, key } = await uploadBrandFile(
          files.secondaryLogo[0],
          userId,
          "logo"
        );
        attachments.push({
          type: "secondaryLogo",
          url,
          key,
          filename: files.secondaryLogo[0].originalname,
        });
      }

      if (files.brandGuide && files.brandGuide[0]) {
        const { url, key } = await uploadBrandFile(
          files.brandGuide[0],
          userId,
          "documents"
        );
        attachments.push({
          type: "brandGuide",
          url,
          key,
          filename: files.brandGuide[0].originalname,
        });
      }

      if (files.additionalAssets) {
        for (const file of files.additionalAssets) {
          const { url, key } = await uploadBrandFile(file, userId, "assets");
          attachments.push({
            type: "asset",
            url,
            key,
            filename: file.originalname,
          });
        }
      }

      // Get current user to access existing brand guidelines
      const userResult = await dynamodb
        .query({
          TableName: `${TABLE_PREFIX}AW-Users`,
          IndexName: "UserIdIndex",
          KeyConditionExpression: "userId = :userId",
          ExpressionAttributeValues: {
            ":userId": userId,
          },
        })
        .promise();

      if (!userResult.Items || userResult.Items.length === 0) {
        return res.status(404).json({ error: "User not found" });
      }

      const user = userResult.Items[0];
      const existingBrandGuidelines = user.brandGuidelines;

      // Parse keyMessages if it's a string
      let parsedKeyMessages = [];
      if (keyMessages) {
        try {
          parsedKeyMessages =
            typeof keyMessages === "string"
              ? JSON.parse(keyMessages)
              : keyMessages;
        } catch (e) {
          parsedKeyMessages =
            typeof keyMessages === "string" ? [keyMessages] : keyMessages;
        }
      }

      // Parse brandValues if it's a string
      let parsedBrandValues = [];
      if (brandValues) {
        try {
          parsedBrandValues =
            typeof brandValues === "string"
              ? JSON.parse(brandValues)
              : brandValues;
        } catch (e) {
          parsedBrandValues =
            typeof brandValues === "string" ? [brandValues] : brandValues;
        }
      }

      const brandGuidelinesData = {
        brandData: {
          brandName: brandName || "",
          tagline: tagline || "",
          primaryColor: primaryColor || "",
          secondaryColor: secondaryColor || "",
          fontFamily: fontFamily || "",
          toneOfVoice: toneOfVoice || "",
          keyMessages: parsedKeyMessages,
          brandValues: parsedBrandValues,
          targetAudience: targetAudience || "",
          brandPersonality: brandPersonality || "",
        },
        attachments: [
          ...(existingBrandGuidelines?.attachments || []),
          ...attachments,
        ],
        createdAt:
          existingBrandGuidelines?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // Update user record with brand guidelines
      await dynamodb
        .update({
          TableName: `${TABLE_PREFIX}AW-Users`,
          Key: { email: user.email }, // Use email as primary key
          UpdateExpression:
            "SET brandGuidelines = :brandGuidelines, updatedAt = :updatedAt",
          ExpressionAttributeValues: {
            ":brandGuidelines": brandGuidelinesData,
            ":updatedAt": new Date().toISOString(),
          },
        })
        .promise();

      res.status(201).json({
        message: "Brand guidelines saved successfully",
        attachments: attachments.length,
      });
    } catch (error) {
      console.error("Error saving brand guidelines:", error);
      res.status(500).json({ error: "Failed to save brand guidelines" });
    }
  }
);

// Delete a brand asset
router.delete("/guidelines/asset/:key", authenticateToken, async (req, res) => {
  try {
    const userId = (req as AuthenticatedRequest).user?.userId;
    const { key } = req.params;

    if (!userId) {
      return res.status(401).json({ error: "User ID not provided" });
    }

    // Get current user and brand guidelines
    const result = await dynamodb
      .query({
        TableName: `${TABLE_PREFIX}AW-Users`,
        IndexName: "UserIdIndex",
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: {
          ":userId": userId,
        },
      })
      .promise();

    if (!result.Items || result.Items.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const user = result.Items[0];
    const brandGuidelines = user.brandGuidelines;

    if (!brandGuidelines) {
      return res.status(404).json({ error: "Brand guidelines not found" });
    }

    // Remove the asset from attachments
    const updatedAttachments = (brandGuidelines.attachments || []).filter(
      (attachment: any) => attachment.key !== key
    );

    // Delete from S3
    try {
      await s3
        .deleteObject({
          Bucket: process.env.AWS_S3_BUCKET || "agentweb-user-files",
          Key: decodeURIComponent(key),
        })
        .promise();
    } catch (s3Error) {
      console.warn("Failed to delete from S3:", s3Error);
      // Continue with database update even if S3 deletion fails
    }

    // Update the user's brand guidelines
    const updatedBrandGuidelines = {
      ...brandGuidelines,
      attachments: updatedAttachments,
      updatedAt: new Date().toISOString(),
    };

    await dynamodb
      .update({
        TableName: `${TABLE_PREFIX}AW-Users`,
        Key: { email: user.email },
        UpdateExpression:
          "SET brandGuidelines = :brandGuidelines, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":brandGuidelines": updatedBrandGuidelines,
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    res.json({ message: "Asset deleted successfully" });
  } catch (error) {
    console.error("Error deleting brand asset:", error);
    res.status(500).json({ error: "Failed to delete brand asset" });
  }
});

export default router;
