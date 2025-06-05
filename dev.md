# Continue with Google not working in dev
It could be due to auth related code was changed and the change would require restart `npm run dev` in order for the Google Login to work again.

# prod deployment on AWS Beanstalk
June 03, 2025: a deployment to backend failed and it failed to revert back to previous version. Restarting the app server and rebuilt the environemnt not worked. To resolve the issue, we had to clone the environment and then pointed the dns record in route 53 to the new environment.

June 04, 2025: another outage of the backend. To resolve the issue and improve reliability, updated the environment to use t3-small instead of t3-micro as first option and t3-medium as second option. It was t3-micro then t3-small.