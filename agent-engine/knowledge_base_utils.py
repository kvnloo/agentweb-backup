import logging
import os
import boto3
from botocore.exceptions import ClientError
import uuid
import json # Ensure json is imported
from typing import List, Dict, Optional, Any

logger = logging.getLogger(__name__)

# --- Configuration (expected from environment variables) ---
AWS_BEDROCK_KB_ID = os.getenv('AWS_BEDROCK_KB_ID')
AWS_BEDROCK_KB_S3_BUCKET = os.getenv('AWS_BEDROCK_KB_S3_BUCKET')
AWS_BEDROCK_KB_S3_PREFIX = os.getenv('AWS_BEDROCK_KB_S3_PREFIX', 'agent_knowledge/') # Default prefix if not set
AWS_BEDROCK_REGION_NAME = os.getenv('AWS_BEDROCK_REGION_NAME', os.getenv('AWS_REGION', 'us-east-1')) # Use specific Bedrock region or general AWS region

_bedrock_agent_runtime_client = None
_s3_client = None
_bedrock_client = None # For GetKnowledgeBase if needed

def _get_bedrock_agent_runtime_client():
    global _bedrock_agent_runtime_client
    if _bedrock_agent_runtime_client is None:
        try:
            _bedrock_agent_runtime_client = boto3.client('bedrock-agent-runtime', region_name=AWS_BEDROCK_REGION_NAME)
            logger.info(f"Bedrock Agent Runtime client initialized for region: {AWS_BEDROCK_REGION_NAME}.")
        except Exception as e:
            logger.error(f"Error initializing Bedrock Agent Runtime client: {e}", exc_info=True)
            raise
    return _bedrock_agent_runtime_client

def _get_bedrock_client():
    global _bedrock_client
    if _bedrock_client is None:
        try:
            _bedrock_client = boto3.client('bedrock', region_name=AWS_BEDROCK_REGION_NAME)
            logger.info(f"Bedrock (standard) client initialized for region: {AWS_BEDROCK_REGION_NAME}.")
        except Exception as e:
            logger.error(f"Error initializing Bedrock (standard) client: {e}", exc_info=True)
            raise
    return _bedrock_client


def _get_s3_client():
    global _s3_client
    if _s3_client is None:
        try:
            # S3 client typically doesn't need a region if bucket is globally unique,
            # but specifying can be good practice if working with regional features or needing consistent config.
            _s3_client = boto3.client('s3', region_name=AWS_BEDROCK_REGION_NAME) # Use same region for consistency
            logger.info(f"S3 client initialized for region: {AWS_BEDROCK_REGION_NAME}.")
        except Exception as e:
            logger.error(f"Error initializing S3 client: {e}", exc_info=True)
            raise
    return _s3_client


def initialize_kb() -> bool:
    """
    Initializes and checks prerequisites for the AWS Bedrock knowledge base.
    """
    logger.info("Initializing AWS Bedrock Knowledge Base interface...")
    if not AWS_BEDROCK_KB_ID:
        logger.error("AWS_BEDROCK_KB_ID environment variable not set.")
        return False
    if not AWS_BEDROCK_KB_S3_BUCKET:
        logger.error("AWS_BEDROCK_KB_S3_BUCKET environment variable not set.")
        return False
    
    try:
        _get_bedrock_agent_runtime_client()
        _get_s3_client()
        _get_bedrock_client() # Initialize standard bedrock client too
        logger.info("AWS Bedrock KB interface initialized successfully. KB ID: %s, S3 Bucket: %s, S3 Prefix: '%s', Region: %s",
                    AWS_BEDROCK_KB_ID, AWS_BEDROCK_KB_S3_BUCKET, AWS_BEDROCK_KB_S3_PREFIX, AWS_BEDROCK_REGION_NAME)
        return True
    except Exception as e:
        logger.error(f"Failed to initialize AWS Bedrock KB interface components: {e}", exc_info=True)
        return False

def add_document_to_kb_source(document_content: str, document_title: Optional[str] = None, document_id: Optional[str] = None) -> Optional[str]:
    """
    Adds a new document (text content) to the S3 data source for the Bedrock Knowledge Base.
    Bedrock will pick this up during its next sync.

    Args:
        document_content: The string content of the document.
        document_title: Optional title for the document. If None, a UUID-based name will be used.
        document_id: Optional unique ID. If provided, used as part of filename. Otherwise, UUID is used.

    Returns:
        The S3 object key if successful, None otherwise.
    """
    if not document_content or not isinstance(document_content, str):
        logger.warning("Attempted to add empty or non-string content to KB source.")
        return None

    if not AWS_BEDROCK_KB_S3_BUCKET:
        logger.error("AWS_BEDROCK_KB_S3_BUCKET not configured. Cannot add document.")
        if not initialize_kb():
             logger.error("Failed to auto-initialize KB in add_document_to_kb_source.")
             return None
    
    s3_client = _get_s3_client()
    
    base_filename = document_id or str(uuid.uuid4())
    if document_title:
        # Basic sanitization for title part of filename
        sane_title = "".join(c if c.isalnum() or c in ['.', '-', '_'] else '_' for c in document_title) # Python 3.9 compatible
        filename = f"{sane_title[:50]}_{base_filename}.txt" # Truncate title part, ensure txt
    else:
        filename = f"doc_{base_filename}.txt"

    # Ensure prefix ends with a slash if it's not empty and not just "/"
    s3_prefix_to_use = AWS_BEDROCK_KB_S3_PREFIX
    if s3_prefix_to_use and not s3_prefix_to_use.endswith('/'):
        s3_prefix_to_use += '/'
    if s3_prefix_to_use == '/': # Avoid double slash at start if prefix is just root
        s3_prefix_to_use = ''

    s3_key = f"{s3_prefix_to_use}{filename}"
    s3_key = s3_key.lstrip('/') # Ensure no leading slash if prefix was empty


    try:
        logger.info(f"Adding document to S3: s3://{AWS_BEDROCK_KB_S3_BUCKET}/{s3_key} (first 100 chars): {document_content[:100]}")
        s3_client.put_object(
            Bucket=AWS_BEDROCK_KB_S3_BUCKET,
            Key=s3_key,
            Body=document_content.encode('utf-8'),
            ContentType='text/plain; charset=utf-8' # Specify charset
        )
        logger.info(f"Successfully uploaded document to s3://{AWS_BEDROCK_KB_S3_BUCKET}/{s3_key}")
        return s3_key
    except ClientError as e:
        logger.error(f"S3 ClientError uploading document (s3://{AWS_BEDROCK_KB_S3_BUCKET}/{s3_key}): {e}", exc_info=True)
        return None
    except Exception as e:
        logger.error(f"Unexpected error uploading document to S3: {e}", exc_info=True)
        return None


def _fetch_knowledge_base_model_arn(kb_id: str) -> Optional[str]:
    """
    Helper to attempt to fetch the model ARN configured for a knowledge base.
    This is useful if the RetrieveAndGenerate call needs it explicitly and it's not hardcoded.
    """
    try:
        bedrock_client = _get_bedrock_client() # Standard Bedrock client
        response = bedrock_client.get_knowledge_base(knowledgeBaseId=kb_id)
        # The model ARN is typically within knowledgeBaseConfiguration.vectorKnowledgeBaseConfiguration.embeddingModelArn
        # However, for RetrieveAndGenerate, it's often an FM ARN used for synthesis, which might be part of retrievalOverride
        # For RetrieveAndGenerate, the model for synthesis is specified in the call or is a KB default.
        # This function is more about finding the *embedding* model if needed, or general KB config.
        # For simplicity, we'll rely on RetrieveAndGenerate using its configured model or one passed to it.
        # The API itself requires modelArn in knowledgeBaseConfiguration if not using an override.
        # Let's return the embedding model ARN as an example, though it might not be what R&G directly uses for synthesis.
        embedding_model_arn = response.get('knowledgeBase', {}).get('knowledgeBaseConfiguration', {}).get('vectorKnowledgeBaseConfiguration', {}).get('embeddingModelArn')
        if embedding_model_arn:
            logger.info(f"Found embedding model ARN for KB {kb_id}: {embedding_model_arn}")
            # This is the EMBEDDING model. R&G needs a GENERATION model.
            # It's better to rely on KB default or explicitly pass generation model ARN.
            # Returning None to force use of KB default or explicit pass for generation.
            logger.warning("Returning None for generation model ARN from _fetch_knowledge_base_model_arn; use KB default or pass explicitly.")
            return None
        else: # The model for generation is often implicit or configured in the console for the KB's RAG settings.
            logger.warning(f"Could not determine a specific model ARN from KB {kb_id} structure for generation. Will rely on RetrieveAndGenerate default or passed model.")
            return None # Fallback to whatever RetrieveAndGenerate uses by default or is passed
    except ClientError as e:
        logger.error(f"Could not fetch details for KB {kb_id} to find model ARN: {e}")
        return None # Fallback


def query_kb_retrieve_and_generate(query_text: str,
                                   model_arn_for_generation: Optional[str] = None,
                                   number_of_results: int = 3 # Max source chunks for RAG
                                  ) -> Optional[Dict[str, Any]]:
    """
    Queries the Bedrock Knowledge Base using RetrieveAndGenerate API.
    This retrieves relevant chunks and uses an LLM to synthesize an answer.

    Args:
        query_text: The query string.
        model_arn_for_generation: Optional ARN of the Bedrock *foundation model* to use for *generating* the response.
                                  If None, the KB's default generation model is used.
        number_of_results: Max number of source chunks to retrieve for context.

    Returns:
        The response dictionary from Bedrock if successful, None otherwise.
        Response typically includes 'output' (generated text) and 'citations'.
    """
    if not AWS_BEDROCK_KB_ID:
        logger.error("AWS_BEDROCK_KB_ID not configured. Cannot query.")
        if not initialize_kb():
             logger.error("Failed to auto-initialize KB in query_kb_retrieve_and_generate.")
             return None

    bedrock_agent_runtime = _get_bedrock_agent_runtime_client()

    try:
        logger.info(f"Querying Bedrock KB '{AWS_BEDROCK_KB_ID}' with: {query_text[:100]}")
        
        retrieval_config = {
            "vectorSearchConfiguration": {
                "numberOfResults": number_of_results
            }
        }
        
        kb_config_for_api = {
            "knowledgeBaseId": AWS_BEDROCK_KB_ID,
            "retrievalConfiguration": retrieval_config 
        }

        # Only add modelArn to kb_config_for_api if it's explicitly provided for generation.
        # Otherwise, Bedrock will use the KB's default configured generation model.
        if model_arn_for_generation:
            kb_config_for_api["modelArn"] = model_arn_for_generation
            logger.info(f"Using explicitly provided generation model ARN: {model_arn_for_generation}")
        else:
            logger.info(f"No explicit generation model ARN provided. Relying on Bedrock KB '{AWS_BEDROCK_KB_ID}' default generation model.")
            # Attempting to use _fetch_knowledge_base_model_arn here for generation model is unreliable
            # as it usually fetches embedding model. Best to let Bedrock handle default.

        api_params = {
            "input": {"text": query_text},
            "retrieveAndGenerateConfiguration": {
                "type": "KNOWLEDGE_BASE",
                "knowledgeBaseConfiguration": kb_config_for_api
            }
        }

        response = bedrock_agent_runtime.retrieve_and_generate(**api_params)
        
        logger.info(f"Bedrock KB RetrieveAndGenerate successful. SessionId: {response.get('sessionId')}")
        return response

    except ClientError as e:
        error_code = e.response.get("Error", {}).get("Code")
        error_message = e.response.get("Error", {}).get("Message")
        logger.error(f"Bedrock API ClientError querying KB '{AWS_BEDROCK_KB_ID}': {error_code} - {error_message}", exc_info=True)
        if "AccessDeniedException" in str(e):
            logger.error("Access Denied: Ensure the execution role has permissions for bedrock:RetrieveAndGenerate on the KB and bedrock:InvokeModel for the generation model.")
        elif "ResourceNotFoundException" in str(e):
            logger.error(f"Resource Not Found: Verify AWS_BEDROCK_KB_ID ('{AWS_BEDROCK_KB_ID}') is correct and the KB exists in region {AWS_BEDROCK_REGION_NAME}.")
        elif "ValidationException" in str(e) and "modelArn" in error_message:
             logger.error(f"Validation Error with modelArn. Ensure the model ARN in knowledgeBaseConfiguration ('{kb_config_for_api.get('modelArn')}') is a valid *foundation model ARN for generation*, or remove it to use KB's default. The KB itself should also have a valid embedding model configured.")
        return None
    except Exception as e:
        logger.error(f"Unexpected error querying Bedrock KB '{AWS_BEDROCK_KB_ID}': {e}", exc_info=True)
        return None

def trigger_kb_sync(knowledge_base_id: str, data_source_id: str) -> Optional[str]:
    """
    Starts an ingestion job for the specified Bedrock Knowledge Base data source.

    Args:
        knowledge_base_id: The ID of the Bedrock Knowledge Base.
        data_source_id: The ID of the Data Source within the Knowledge Base to sync.
                        This is CRITICAL. Find in Bedrock console or via GetKnowledgeBase/ListDataSources API.

    Returns:
        The ingestion job ID if successful, None otherwise.
    """
    if not data_source_id: 
        logger.error("data_source_id is required to trigger a KB sync.")
        return None

    try:
        bedrock_agent_client = boto3.client('bedrock-agent', region_name=AWS_BEDROCK_REGION_NAME)
    except Exception as e:
        logger.error(f"Error initializing Bedrock Agent client for sync: {e}", exc_info=True)
        return None

    try:
        logger.info(f"Attempting to start ingestion job for KB '{knowledge_base_id}', DataSource '{data_source_id}'")
        client_request_token = str(uuid.uuid4())
        
        response = bedrock_agent_client.start_ingestion_job(
            knowledgeBaseId=knowledge_base_id,
            dataSourceId=data_source_id,
            clientRequestToken=client_request_token 
        )
        ingestion_job_id = response.get('ingestionJob', {}).get('ingestionJobId')
        logger.info(f"Successfully started ingestion job. Job ID: {ingestion_job_id} for KB '{knowledge_base_id}', DataSource '{data_source_id}'")
        return ingestion_job_id
    except ClientError as e:
        logger.error(f"Bedrock API ClientError starting ingestion job for KB '{knowledge_base_id}', DataSource '{data_source_id}': {e}", exc_info=True)
        return None
    except Exception as e:
        logger.error(f"Unexpected error starting ingestion job for KB '{knowledge_base_id}', DataSource '{data_source_id}': {e}", exc_info=True)
        return None 