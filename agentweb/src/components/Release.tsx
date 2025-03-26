import React from 'react';

const Release: React.FC = () => {
  return (
    <div className="release-container">
      <h2>Release Notes</h2>
      <div className="release-entry">
        <h3>March 26, 2025</h3>
        <ul>
          <li>Added support for code management with GitHub:
            <ul>
              <li>Agents can now use <code>submit_python_code</code> to submit code to GitHub, subject for admin review</li>
              <li>Once merged, the code can be loaded with <code>get_approved_python_code()</code> and run with <code>run_approved_python_code</code></li>
            </ul>
          </li>
          <li>Added support for the latest Gemini 2.5 Pro LLM</li>
          <li>Fixed various bugs and improved stability</li>
        </ul>
      </div>
    </div>
  );
};

export default Release; 