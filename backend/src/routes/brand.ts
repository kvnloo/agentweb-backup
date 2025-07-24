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
        TableName: `${TABLE_PREFIX}AW-Configs`,
        KeyConditionExpression: "userId = :userId",
        FilterExpression: "isBrandConfig = :isBrandConfig",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":isBrandConfig": true,
        },
      })
      .promise();

    const brandConfigs = result.Items || [];

    if (brandConfigs.length === 0) {
      return res.json({
        exists: false,
        message: "No brand guidelines found",
      });
    }

    // Return the first/primary brand configuration
    const brandConfig = brandConfigs[0];
    const { encryptedPassword, password, ...brandWithoutSensitive } =
      brandConfig;

    res.json({
      exists: true,
      ...brandWithoutSensitive,
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

      // Check if brand config already exists
      const existingResult = await dynamodb
        .query({
          TableName: `${TABLE_PREFIX}AW-Configs`,
          KeyConditionExpression: "userId = :userId",
          FilterExpression: "isBrandConfig = :isBrandConfig",
          ExpressionAttributeValues: {
            ":userId": userId,
            ":isBrandConfig": true,
          },
        })
        .promise();

      const configId =
        existingResult.Items && existingResult.Items.length > 0
          ? existingResult.Items[0].configId
          : uuidv4();

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

      const brandConfig = {
        configId,
        userId,
        isBrandConfig: true,
        appName: "Brand Guidelines",
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
          ...((existingResult.Items && existingResult.Items[0]?.attachments) ||
            []),
          ...attachments,
        ],
        shareWithEveryone: 0,
        createdAt:
          existingResult.Items && existingResult.Items.length > 0
            ? existingResult.Items[0].createdAt
            : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await dynamodb
        .put({
          TableName: `${TABLE_PREFIX}AW-Configs`,
          Item: brandConfig,
        })
        .promise();

      res.status(201).json({
        message: "Brand guidelines saved successfully",
        configId,
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

    // Get current brand config
    const result = await dynamodb
      .query({
        TableName: `${TABLE_PREFIX}AW-Configs`,
        KeyConditionExpression: "userId = :userId",
        FilterExpression: "isBrandConfig = :isBrandConfig",
        ExpressionAttributeValues: {
          ":userId": userId,
          ":isBrandConfig": true,
        },
      })
      .promise();

    if (!result.Items || result.Items.length === 0) {
      return res.status(404).json({ error: "Brand configuration not found" });
    }

    const brandConfig = result.Items[0];

    // Remove the asset from attachments
    const updatedAttachments = (brandConfig.attachments || []).filter(
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

    // Update the brand config
    await dynamodb
      .update({
        TableName: `${TABLE_PREFIX}AW-Configs`,
        Key: {
          userId,
          configId: brandConfig.configId,
        },
        UpdateExpression:
          "SET attachments = :attachments, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":attachments": updatedAttachments,
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
