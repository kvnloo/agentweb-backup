# Continue with Google not working in dev
It could be due to auth related code was changed and the change would require restart `npm run dev` in order for the Google Login to work again.

# prod deployment on AWS Beanstalk
June 03, 2025: a deployment to backend failed and it failed to revert back to previous version. Restarting the app server and rebuilt the environemnt not worked. To resolve the issue, we had to clone the environment and then pointed the dns record in route 53 to the new environment.

June 04, 2025: another outage of the backend. To resolve the issue and improve reliability, updated the environment to use t3-small instead of t3-micro as first option and t3-medium as second option. It was t3-micro then t3-small.

June 16, 2025:
# Known issues of Gemini model with browser use
Gemini models cannot work with the BaseModel argument with function call. Also it has a strange issue that require minimum 1 argument. We needed to add patch to use simpler argument for gemini models.

June 19, 2025
The latest version of browser-use (0.2.7) has an issue of using the same persistent storage for session data which mixed the cookie files from different users. 

June 21, 2025
When restoring a previous good version of browser-use, an issue about old_history table or index crash arised. It was initially suspected to be issue with browser use or playwright but after several round of testings the issue was with the memory dependency of browser use. Uninstall the component solved the issue as this is not a hard dependency:
`pip uninstall -y mem0ai`
To reinstall it, run
`pip install "browser-use[memory]"`