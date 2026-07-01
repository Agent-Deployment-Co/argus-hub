/** Minimal HTML pages served by the Hub. No build step — embedded strings.
 *  Palette matches the SPA's light theme (web/src/styles.css): antique-white background,
 *  porcelain surfaces, dark-coffee text, tiger-orange accent. */

const SHARED_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #f9ebdc;
    color: #341f09;
    font: 15px/1.55 Georgia, serif;
    min-height: 100vh;
    padding: 24px;
  }
  .card {
    background: #fefaf5;
    border: 1px solid rgba(52, 31, 9, .16);
    border-top: 3px solid #ef8920;
    border-radius: 12px;
    padding: 36px 40px;
    width: 100%;
    max-width: 380px;
    margin: 0 auto;
  }
  .brand-wordmark {
    height: 28px;
    width: auto;
    flex-shrink: 0;
    display: block;
    padding: 2px 4px 2px 0;
  }
  h1 {
    font-family: "Avenir Next", Arial, sans-serif;
    font-size: 22px;
    font-weight: 700;
    color: #1c1105;
    margin-bottom: 20px;
  }
  label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    color: #6b5238;
    text-transform: uppercase;
    letter-spacing: .5px;
    margin-bottom: 6px;
  }
  input[type="password"] {
    width: 100%;
    background: #f9ebdc;
    border: 1px solid rgba(52, 31, 9, .25);
    border-radius: 6px;
    color: #341f09;
    font: 15px/1 Georgia, serif;
    padding: 10px 12px;
    outline: none;
    transition: border-color .15s;
  }
  input[type="password"]:focus { border-color: #ef8920; }
  button[type="submit"] {
    width: 100%;
    margin-top: 20px;
    background: #ef8920;
    border: none;
    border-radius: 6px;
    color: #fefaf5;
    cursor: pointer;
    font: 600 14px/1 "Avenir Next", Arial, sans-serif;
    padding: 11px 16px;
    transition: opacity .15s;
  }
  button[type="submit"]:hover { opacity: .88; }
  .error {
    background: rgba(226, 48, 44, .12);
    border: 1px solid rgba(226, 48, 44, .35);
    border-radius: 6px;
    color: #b51a16;
    font-size: 13px;
    margin-bottom: 16px;
    padding: 10px 12px;
  }
`;

const BRAND_SVG = `<svg class="brand-wordmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 88.67 17.87" overflow="visible" role="img" aria-label="Argus Hub">
  <path fill="#e2302c" d="M0,17.63v-8.82C0,3.95,3.95,0,8.82,0s8.82,3.95,8.82,8.82v8.82h-1.68v-8.82c0-3.94-3.2-7.14-7.14-7.14S1.68,4.87,1.68,8.82v8.82H0Z"/>
  <path fill="#ef8920" d="M1.93,17.63v-8.82c0-3.8,3.08-6.88,6.88-6.88s6.88,3.08,6.88,6.88v8.82h-1.68v-8.82c0-2.87-2.33-5.21-5.21-5.21s-5.21,2.33-5.21,5.21v8.82h-1.68Z"/>
  <path fill="#5dbcdf" d="M3.86,17.63v-8.82c0-2.74,2.22-4.95,4.95-4.95s4.95,2.22,4.95,4.95v8.82h-1.68v-8.82c0-1.81-1.47-3.27-3.27-3.27s-3.27,1.47-3.27,3.27v8.82h-1.68Z"/>
  <path fill="#286992" d="M5.79,17.63v-8.82c0-1.67,1.35-3.02,3.02-3.02s3.02,1.35,3.02,3.02v8.82h-1.68v-8.82c0-.74-.6-1.34-1.34-1.34s-1.34.6-1.34,1.34v8.82h-1.68Z"/>
  <text style="font-family:'Avenir Next',Arial,sans-serif;font-size:13.6px;font-weight:700;letter-spacing:-0.07em" transform="translate(18.97 13.8)"><tspan x="0" y="0">ARGUS HUB</tspan></text>
</svg>`;

export const LOGIN_PAGE = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Argus Hub — Sign in</title>
  <style>
    ${SHARED_CSS}
    body { display: grid; place-items: center; }
  </style>
</head>
<body>
  <div class="card">
    <div style="margin-bottom:28px">
      ${BRAND_SVG}
    </div>
    <h1>Enter admin password</h1>
    {{ERROR}}
    <form method="POST" action="/login">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autofocus autocomplete="current-password" />
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;

