{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AccountAdministersTheKey",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::@@ACCOUNT@@:root" },
      "Action": [
        "kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetKeyRotationStatus", "kms:GetPublicKey", "kms:ListAliases", "kms:ListKeyPolicies", "kms:ListResourceTags",
        "kms:PutKeyPolicy", "kms:CreateAlias", "kms:UpdateAlias", "kms:DeleteAlias", "kms:UpdateKeyDescription", "kms:ListGrants", "kms:RevokeGrant", "kms:Verify",
        "kms:TagResource", "kms:UntagResource", "kms:EnableKey", "kms:DisableKey", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"
      ],
      "Resource": "*"
    },
    {
      "Sid": "OnlyTheDeployPipelineSigns",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::@@ACCOUNT@@:role/@@CI_ROLE@@" },
      "Action": ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
      "Resource": "*"
    },
    {
      "Sid": "NobodyElseMaySignOrGrantSigning",
      "Effect": "Deny",
      "Principal": "*",
      "Action": ["kms:Sign", "kms:CreateGrant", "kms:RetireGrant", "kms:ReEncrypt*"],
      "Resource": "*",
      "Condition": { "StringNotEquals": { "aws:PrincipalArn": "arn:aws:iam::@@ACCOUNT@@:role/@@CI_ROLE@@" } }
    }
  ]
}
