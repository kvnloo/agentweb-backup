{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AccountAdministersTheKeyButCannotSignWithIt",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::@@ACCOUNT@@:root" },
      "Action": [
        "kms:Create*", "kms:Describe*", "kms:Enable*", "kms:List*", "kms:Put*", "kms:Update*", "kms:Revoke*", "kms:Disable*", "kms:Get*", "kms:Delete*",
        "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion"
      ],
      "Resource": "*"
    },
    {
      "Sid": "OnlyTheDeployPipelineSigns",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::@@ACCOUNT@@:role/@@CI_ROLE@@" },
      "Action": ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"],
      "Resource": "*"
    }
  ]
}
