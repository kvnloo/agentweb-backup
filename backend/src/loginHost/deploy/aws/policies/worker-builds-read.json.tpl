{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadBuildsOnly",
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::@@BUCKET@@/prod/builds/*"
    }
  ]
}
