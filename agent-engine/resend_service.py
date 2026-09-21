#!/usr/bin/env python3
import os
import resend
import logging
import time
from typing import Optional, Dict, Any
import secrets_manager

logger = logging.getLogger(__name__)

class ResendService:
    def __init__(self):
        self.api_key = None
        self.initialized = False
        self._initialize()
    
    def _initialize(self):
        """Initialize Resend service with API key from environment variable"""
        try:
            # Get API key from environment variable
            self.api_key = secrets_manager.get_resend_api_key()
            
            if self.api_key:
                resend.api_key = self.api_key
                self.initialized = True
                logger.info(f"Resend service initialized for {os.getenv('NODE_ENV', 'development')} environment")
            else:
                logger.warning("RESEND_API_KEY not found in environment. Resend service will not be available.")
                
        except Exception as e:
            logger.error(f"Error initializing Resend service: {e}")
            self.initialized = False
    
    def send_email(self, from_email: str, to_email: str, subject: str, html: str = None, text: str = None) -> Optional[Dict[str, Any]]:
        """
        Send email via Resend service
        
        Args:
            from_email: Sender email in format "Name <email@domain.com>"
            to_email: Recipient email
            subject: Email subject
            html: HTML content (optional)
            text: Text content (optional)
            
        Returns:
            Resend response data with email ID, or None if failed
        """
        if not self.initialized:
            logger.error("Resend service not initialized")
            return None
        
        try:
            # Add 500ms delay before sending to minimize rate limit hits
            logger.info(f"Waiting 500ms before sending email to {to_email}...")
            time.sleep(0.5)  # 500ms delay
            
            params = {
                "from": from_email,
                "to": [to_email],
                "subject": subject
            }
            
            if html:
                params["html"] = html
            if text:
                params["text"] = text
            
            response = resend.Emails.send(params)
            
            if response and 'id' in response:
                logger.info(f"Email sent successfully via Resend: {response['id']}")
                return response
            else:
                logger.error(f"Resend email failed: {response}")
                return None
                
        except Exception as e:
            logger.error(f"Error sending email via Resend: {e}")
            return None

# Global instance
resend_service = ResendService()
