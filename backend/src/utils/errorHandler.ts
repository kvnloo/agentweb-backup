export const handleDynamoError = (error: any) => {
  console.error('DynamoDB Error:', error);
  
  if (error.code === 'ConditionalCheckFailedException') {
    throw new Error('Item already exists');
  }
  
  if (error.code === 'ResourceNotFoundException') {
    throw new Error('Table not found');
  }
  
  if (error.code === 'ValidationException') {
    throw new Error('Invalid data format');
  }
  
  throw new Error('Database operation failed');
}; 