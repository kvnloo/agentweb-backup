# Continue with Google not working in dev
It could be due to auth related code was changed and the change would require restart `npm run dev` in order for the Google Login to work again.

# Upgrade npm and node
to see the version `npm -v` and `node -v`
to upgrade, 
```
brew upgrade node
npm install -g npm@latest
```