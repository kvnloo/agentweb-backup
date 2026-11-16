{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteBuildsOnly",
      "Effect": "Allow",
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::@@BUCKET@@/prod/builds/*"
    },
    {
      "Sid": "SignWithTheOneKey",
      "Effect": "Allow",
      "Action": ["kms:Sign", "kms:GetPublicKey"],
      "Resource": "@@KEY_ARN@@"
    },
    {
      "Sid": "RunTheOneDocumentOnTheOneInstance",
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": ["arn:aws:ssm:@@REGION@@:@@ACCOUNT@@:document/@@DOCUMENT@@", "arn:aws:ec2:@@REGION@@:@@ACCOUNT@@:instance/@@INSTANCE@@"]
    },
    {
      "Sid": "ReadTheResult",
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*"
    }
  ]
}
