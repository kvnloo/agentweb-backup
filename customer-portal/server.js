import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// Replicate __dirname behavior in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 8080;

// Serve static files from the 'dist' directory
app.use(express.static(path.join(__dirname, 'dist')));

// For all other GET requests, send back the SPA (index.html)
// This is important for client-side routing to work correctly
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
}); 