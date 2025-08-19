import { spawn } from "child_process";
import path from "path";
import fs from "fs";

interface ImageGenerationResult {
  success: boolean;
  imageUrl?: string;
  filename?: string;
  error?: string;
}

interface ImageGenerationParams {
  prompt: string;
  filename: string;
  size?: string;
  quality?: string;
  inputImages?: string[];
}

export class AgentEngineImageService {
  private agentEnginePath: string;
  private pythonPath: string;

  constructor() {
    // Path to the agent-engine directory
    this.agentEnginePath = path.join(process.cwd(), "..", "agent-engine");

    // Use conda environment if available, otherwise use python
    this.pythonPath = process.env.CONDA_PYTHON_PATH || "python3";
  }

  private getCondaCommand(): string[] {
    if (process.env.CONDA_ENV_PATH) {
      return ["conda", "run", "-p", process.env.CONDA_ENV_PATH, "python"];
    }
    return [this.pythonPath];
  }

  /**
   * Generate an image using the agent-engine's image generation capability
   */
  async generateImage(
    params: ImageGenerationParams
  ): Promise<ImageGenerationResult> {
    try {
      // Prepare the Python script to call the agent-engine image generation
      const scriptContent = `
import sys
import os
import json
import asyncio
import logging
from pathlib import Path

# Add agent-engine to path
sys.path.insert(0, "${this.agentEnginePath}")

# Configure logging to prevent excessive output
logging.getLogger().setLevel(logging.WARNING)

try:
    from web_agent import WebAgent, GenerateImageParams
    
    async def generate_image():
        try:
            # Initialize WebAgent
            agent = WebAgent()
            
            # Prepare parameters
            params = GenerateImageParams(
                input_file_names=${JSON.stringify(params.inputImages || [])},
                prompt="${params.prompt.replace(/"/g, '\\"')}",
                output_file_name="${params.filename}",
                size="${params.size || "1024x1024"}",
                quality="${params.quality || "medium"}"
            )
            
            # Call the generate_image action
            # Find the generate_image action in the registry
            for action_name, action_func in agent.controller.registry.actions.items():
                if "Generate image" in action_name:
                    result = await action_func(params)
                    
                    if result.error:
                        print(json.dumps({
                            "success": False,
                            "error": result.error
                        }))
                        return
                    
                    # Check if the image was created successfully
                    downloads_path = agent._get_downloads_path()
                    image_path = Path(downloads_path) / "${params.filename}"
                    
                    if image_path.exists():
                        print(json.dumps({
                            "success": True,
                            "filename": "${params.filename}",
                            "path": str(image_path)
                        }))
                    else:
                        print(json.dumps({
                            "success": False,
                            "error": "Image file was not created"
                        }))
                    return
            
            print(json.dumps({
                "success": False,
                "error": "Image generation action not found"
            }))
            
        except Exception as e:
            print(json.dumps({
                "success": False,
                "error": f"Error in image generation: {str(e)}"
            }))
    
    # Run the async function
    asyncio.run(generate_image())
    
except ImportError as e:
    print(json.dumps({
        "success": False,
        "error": f"Failed to import agent-engine modules: {str(e)}"
    }))
except Exception as e:
    print(json.dumps({
        "success": False,
        "error": f"Unexpected error: {str(e)}"
    }))
`;

      // Write the script to a temporary file
      const tempScriptPath = path.join(
        this.agentEnginePath,
        "temp_image_gen.py"
      );
      fs.writeFileSync(tempScriptPath, scriptContent);

      return new Promise((resolve) => {
        const pythonProcess = spawn(
          this.getCondaCommand()[0],
          [...this.getCondaCommand().slice(1), tempScriptPath],
          {
            cwd: this.agentEnginePath,
            env: {
              ...process.env,
              PYTHONPATH: this.agentEnginePath,
            },
          }
        );

        let outputData = "";
        let errorData = "";

        pythonProcess.stdout.on("data", (data) => {
          outputData += data.toString();
        });

        pythonProcess.stderr.on("data", (data) => {
          errorData += data.toString();
        });

        pythonProcess.on("close", async (code) => {
          // Clean up temp script
          try {
            fs.unlinkSync(tempScriptPath);
          } catch (e) {
            console.warn("Could not clean up temp script:", e);
          }

          if (code === 0) {
            try {
              const result = JSON.parse(outputData.trim());

              if (result.success && result.path) {
                // Upload the generated image to S3 or return the local path
                // For now, we'll just return the local path
                resolve({
                  success: true,
                  imageUrl: `file://${result.path}`,
                  filename: result.filename,
                });
              } else {
                resolve({
                  success: false,
                  error: result.error || "Unknown error in image generation",
                });
              }
            } catch (parseError) {
              resolve({
                success: false,
                error: `Failed to parse result: ${parseError}. Output: ${outputData}`,
              });
            }
          } else {
            resolve({
              success: false,
              error: `Python process failed with code ${code}. Error: ${errorData}`,
            });
          }
        });

        pythonProcess.on("error", (error) => {
          resolve({
            success: false,
            error: `Failed to start Python process: ${error.message}`,
          });
        });
      });
    } catch (error: any) {
      return {
        success: false,
        error: `Image generation service error: ${error.message}`,
      };
    }
  }

  /**
   * Check if the agent-engine image generation is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Check if agent-engine directory exists
      if (!fs.existsSync(this.agentEnginePath)) {
        console.warn("Agent-engine directory not found:", this.agentEnginePath);
        return false;
      }

      // Check if web_agent.py exists
      const webAgentPath = path.join(this.agentEnginePath, "web_agent.py");
      if (!fs.existsSync(webAgentPath)) {
        console.warn("web_agent.py not found in agent-engine");
        return false;
      }

      return true;
    } catch (error) {
      console.warn("Error checking agent-engine availability:", error);
      return false;
    }
  }
}

// Create a singleton instance
export const agentEngineImageService = new AgentEngineImageService();
