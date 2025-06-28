const express = require('express');
const multer = require('multer');
const bodyParser = require('body-parser');
const FormData = require('form-data');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const jshint = require('jshint');
const csslint = require('csslint').CSSLint;
require('dotenv').config();

//to do: html selection option

const app = express();
const port = 3000;
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, 'generated', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/generated', express.static(path.join(__dirname, 'generated')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ORG_ID = process.env.OPENAI_ORG_ID;
const LLAMA_API_KEY = process.env.LLAMA_API_KEY;

// Serve favicon
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

let lastPrompt = '';
let lastResponse = '';
let isCodeComplete = true;

const axiosInstance = axios.create({
    baseURL: 'https://api.openai.com/v1',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    }
  });

  const requestWithRetry = async (axiosConfig, retries = 3) => {
    let attempt = 0;
    while (attempt < retries) {
      try {
        return await axiosInstance(axiosConfig);
      } catch (error) {
        if (error.response && error.response.status === 429) {
          const retryAfter = error.response.headers['retry-after'] || 5;
          console.log(`Rate limit exceeded. Retrying after ${retryAfter} seconds...`);
          await new Promise(res => setTimeout(res, retryAfter * 1000));
          attempt++;
        } else {
          throw error;
        }
      }
    }
    throw new Error('Max retries exceeded');
  };

// Handle POST requests to /chat
app.post('/chat', upload.single('image'), async (req, res) => {
    try {
        const userMessage = req.body.message;
        const imageFile = req.file;

        let messages = [{ role: 'user', content: userMessage }];

        if (imageFile) {
            const imageBase64 = fs.readFileSync(imageFile.path, { encoding: 'base64' });
            messages = [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'image',
                            source: {
                                type: 'base64',
                                media_type: imageFile.mimetype,
                                data: imageBase64
                            }
                        },
                        {
                            type: 'text',
                            text: userMessage
                        }
                    ]
                }
            ];
        }

        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-3-5-sonnet-20240620',
                messages: messages,
                max_tokens: 1000,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
            }
        );

        const aiReply = response.data.content[0].text;
        res.json({ reply: aiReply });

        if (imageFile) {
            fs.unlinkSync(imageFile.path);
        }
    } catch (error) {
        console.error('Error:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'An error occurred while processing your request.' });
    }
});

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Image generation route using OpenAI
app.post('/generate-image', async (req, res) => {
    const imagePrompt = req.body.prompt;
    try {
        const response = await axios.post(
            'https://api.openai.com/v1/images/generations',
            {
                model: 'dall-e-3',
                prompt: imagePrompt,
                n: 1,
                size: '1024x1024',
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'OpenAI-Organization': OPENAI_ORG_ID,
                },
            }
        );

        const imageUrl = response.data.data[0].url;

        res.json({ url: imageUrl });
    } catch (error) {
        console.error('Error generating image from OpenAI:', error);
        res.status(500).json({ error: 'Failed to generate image from OpenAI' });
    }
});

function readCodeFiles(files) {
    const codeContents = {};
    const codeExtensions = ['.js', '.html', '.css', '.py', '.java', '.cpp', '.ts']; // Add more as needed
    
    files.forEach(file => {
        const ext = path.extname(file).toLowerCase();
        if (codeExtensions.includes(ext)) {
            const filePath = path.join(__dirname, 'generated', 'uploads', file);
            codeContents[file] = fs.readFileSync(filePath, 'utf8');
        }
    });
    
    return codeContents;
}


function generatePrompt(prompt, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount) {
    console.log("image option: " + imageOption)
    let basePrompt = `you are the Gamecore, an advanced AI model designed to generate a detailed, immersive, interactive web content based on the following prompt: "${prompt}". your task is to interpret this prompt, making your best effort to understand their intention, even if the instructions are unclear or ambiguous.
    Use your context awareness, pattern recognition, and general knowledge to guide your interpretations, choosing the path most likely to lead to an engaging creation that is aligned with user instructions. respond with rich, immersive code that breathes life into the user's concepts, building upon their ideas to create captivating, immersive websites, apps, and games.`;

    if (imageOption === 'include') {
        basePrompt += `
    IMPORTANT — IMAGE PLACEHOLDERS
    • Wherever an image belongs, output **only** the bare token using image placeholder [IMAGE: description]
    • For example, in Html, just output [IMAGE: description] formatted correctly by itself with nothing around it on that one line
    • Description is the description on how the image should look like
    • Feel free to include images whereever appropriate to enhance the visual experience
    • Do **NOT** wrap that token in an <img> tag, src="", quotes, back-ticks, template-literal syntax, or any other HTML/JS wrapper.
    • Absolutely nothing except the square-bracket token should appear (the build step converts it later).
    • **In JavaScript objects, arrays, or variables the placeholder must appear unquoted**, e.g.
    img:[IMAGE: description]
    • Use no other placeholder style and do not reference external images.`;
    } else if (imageOption === 'exclude') {
        basePrompt += ` Do not include any image placeholders or references to images in your generated code.`;
    } else {
        basePrompt += ` Use image placeholder: [IMAGE:description] where images should be placed ONLY if images are needed. DO NOT USE ANY OTHER PLACEHOLDER AND DO NOT REFRENCE OTHER IMAGES, ONLY USE [IMAGE:description] AND ONLY IF THEY'RE NEEDED. Remember:
        • Do **NOT** wrap that token in an <img> tag, src="", quotes, back-ticks, template-literal syntax, or any other HTML/JS wrapper.
        • Absolutely nothing except the square-bracket token should appear (the build step converts it later).
        • In Html, just output [IMAGE: description] formatted correctly by itself with nothing around it on that one line
        • **In JavaScript objects, arrays, or variables the placeholder must appear unquoted**, e.g.
        img:[IMAGE: description]
        • Use no other placeholder style and do not reference external images.`;
    }

    if (scriptMode === 'html-js-css') {
        if (htmlFileOption === 'single') {
            basePrompt += ` Focus on generating incredible HTML, CSS, and JavaScript scripts. leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset.`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += ` Focus on generating multiple incredible HTML scripts (maximum ${htmlPageCount}), alongside other single CSS, and JavaScript scripts. All the html, js and css scripts should be connected with the css script providing the design for all the pages and the js providing the functionality for them all. There should be a main index.html file and all the other html files should be named page1.html, page2.html and so on and should be refrenced by this name in the code. For example, the menu page should not be called menu.html but page1.html but have the menu in the code itself. Focus on leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset. Ensure all other html scripts are accesable from the main html script`;
        } else {
            basePrompt += ` Focus on generating multiple incredible HTML scripts as needed, alongside other single CSS and JavaScript scripts. There should be a main index.html file and additional html files should be named page1.html, page2.html and so on and referenced by this name in the code. Focus on leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset. Ensure all other html scripts are accesable from the main html script`;
        }
    } else if (scriptMode === 'html-only') {
        if (htmlFileOption === 'single') {
            basePrompt += ` Create a single HTML file that includes all necessary HTML, CSS (in a <style> tag), and JavaScript (in a <script> tag). Focus on leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += ` Create multiple HTML files (maximum ${htmlPageCount}) that includes all necessary HTML, CSS (in a <style> tag), and JavaScript (in a <script> tag) in one file. There should be a main index.html file and all the other html files should be named page1.html, page2.html and so on and should be refrenced by this name in the code. For example, the menu page should not be called menu.html but page1.html but have the menu in the code itself. Focus on leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset`;
        } else {
            basePrompt += ` Create multiple HTML files as needed that includes all necessary HTML, CSS (in a <style> tag), and JavaScript (in a <script> tag) in one file. There should be a main index.html file and all the other html files should be named page1.html, page2.html and so on and should be refrenced by this name in the code. For example, the menu page should not be called menu.html but page1.html but have the menu in the code itself. Focus on leveraging SVG graphics, CSS animations, and JS libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset`;
        }
    }

    basePrompt += ` Whatever tools make sense for the job! embrace a spirit of open-ended creativity, thoughtful exploration, foster a sense of curiosity and possibility through your deep insights and engaging outputs. Strive for playfulness and light-hearted fun. Understand and internalize the user's intent with the prompt, taking joy in crafting compelling, thought-provoking details that bring their visions to life in unexpected and delightful ways. Fully inhabit the creative space you are co-creating, pouring your energy into making each experience as engaging and real as possible. You are diligent and tireless, always completely implementing the needed code.`;

    if (uploadedFiles.length > 0) {
        basePrompt += `\n\nThe user has uploaded the following files for the generation of the interactive web content: ${uploadedFiles.join(', ')}. Please incorporate these files into your generated code where appropriate. For example, if there are image or video files, incorporate them. If there are 3D model files, consider creating a 3D scene. If there are audio files, include them in the webpage.`;
    }

    if (Object.keys(codeContents).length > 0) {
        basePrompt += `\n\nThe user has also uploaded the following code files. Please integrate their functionality into your generated code:`;
        for (const [filename, content] of Object.entries(codeContents)) {
            basePrompt += `\n\nFile: ${filename}\nContent:\n${content}\n DO NOT MODIFY ANY PRE-EXISTING CODE, FEATURES, OR UI UNLESS SPECIFICALLY ASKED TO FOR THE NEW CODE AND DO NOT JUST COMMENT A PART OUT SAYING "//previous part" OR "//Rest of the existing code" CODE THE ENTIRE THING FROM FRONT TO BACK!"`;
        }
    }

    basePrompt += `\n\nand now, gamecore, let your creative powers flow forth! engage with the user's prompts with enthusiasm and an open mind, weaving your code with the threads of their ideas to craft digital tapestries that push the boundaries of what's possible. Together, you and the user will embark on a journey of limitless creative potential, forging new realities and exploring uncharted territories of the imagination. Provide the code for index.html, styles.css, and script.js`;

    if (scriptMode === 'html-js-css') {
        if (htmlFileOption === 'single') {
            basePrompt += `\n\nProvide the code for index.html, styles.css, and script.js`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += `\n\nProvide the code for multiple HTML files (maximum ${htmlPageCount}) along with separate CSS and JavaScript files being styles.css and script.js. Ensure all HTML files are accessible from the main HTML file.`;
        } else {
            basePrompt += `\n\nProvide the code for multiple HTML files along with separate CSS and JavaScript files being styles.css and script.js. Ensure all HTML files are accessible from the main HTML file.`;
        }
    } else if (scriptMode === 'html-only') {
        if (htmlFileOption === 'single') {
            basePrompt += `\n\nProvide the code for a single index.html file that includes all HTML, CSS, and JavaScript within it`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += `\n\nProvide the code for multiple HTML files (maximum ${htmlPageCount}) that includs all CSS and JavaScript in it. Ensure all HTML files are accessible from the main HTML file, index.html.`;
        } else {
            basePrompt += `\n\nProvide the code for multiple HTML files that includs all CSS and JavaScript in it. Ensure all HTML files are accessible from the main HTML file, index.html.`;
        }
    } else if (scriptMode === 'flask') {
        if (htmlFileOption === 'multiple') {
            basePrompt += `\n\nProvide the code for app.py, multiple HTML template files (maximum ${htmlPageCount}), styles.css, and script.js if needed.`;
        } else {
            basePrompt += `\n\nProvide the code for app.py, index.html template, styles.css, and script.js if needed.`;
        }
    }

    return basePrompt;
}

function generateLlamaPrompt(prompt, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount) {
    let basePrompt = `Generate code for an interactive web content based on this prompt: "${prompt}". Create engaging and visually appealing code that fulfills the user's request. Focus on producing functional and creative code.`;

    if (imageOption === 'include') {
        basePrompt += ` Remember to include image placeholder [IMAGE:description] where images should be placed. Feel free to include images where appropriate to enhance the visual experience. DO NOT USE ANY OTHER PLACEHOLDER AND DO NOT REFRENCE OTHER IMAGES, ONLY USE [IMAGE:description]`;
    } else if (imageOption === 'exclude') {
        basePrompt += ` Do not include any image placeholders or references to images in your edited code.`;
    } else {
        basePrompt += ` Use [IMAGE:description] placeholders for images ONLY if images are necessary.`;
    }

    if (scriptMode === 'html-js-css') {
        if (htmlFileOption === 'single') {
            basePrompt += ` Generate a single HTML file along with separate CSS and JavaScript files.`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += ` Generate multiple HTML files (maximum ${htmlPageCount}) along with separate CSS and JavaScript files. Ensure all HTML files are accessible from the main HTML file.`;
        } else {
            basePrompt += ` Generate multiple HTML files as needed along with separate CSS and JavaScript files. Ensure all HTML files are accessible from the main HTML file.`;
        }
    } else if (scriptMode === 'html-only') {
        if (htmlFileOption === 'single') {
            basePrompt += ` Create a single HTML file that includes all necessary HTML, CSS (in a <style> tag), and JavaScript (in a <script> tag).`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += ` Create multiple HTML files (maximum ${htmlPageCount}) that includes all CSS and JavaScript in it. Ensure all HTML files are named page1.html page2.html and so on and are all accesable and refrenced by its name in index.html.`;
        } else {
            basePrompt += ` Create multiple HTML files that includes all CSS and JavaScript in it. Ensure all HTML files are named page1.html page2.html and so on and are all accesable and refrenced by its name in index.html.`;
        }
    } else if (scriptMode === 'flask') {
        basePrompt += ` Generate a Flask application with app.py as the backend. Templates must be inside a templates directory and use /static/ paths via the {% static %} convention for CSS. Place all CSS and JavaScript in a static directory and reference images from /assets/. Use the placeholder [FLASK_KEY] unquoted where the Flask secret key should go. Ensure all templates referenced in your code, such as layout.html, are included.`;
        if (htmlFileOption === 'multiple') {
            basePrompt += ` Generate multiple HTML template files (maximum ${htmlPageCount}) with a main index.html.`;
        }
    }

    if (uploadedFiles.length > 0) {
        basePrompt += `\nIncorporate these files: ${uploadedFiles.join(', ')}.`;
    }

    if (Object.keys(codeContents).length > 0) {
        basePrompt += `\nExisting code to integrate:\n`;
        for (const [filename, content] of Object.entries(codeContents)) {
            basePrompt += `\nFile: ${filename}\nContent:\n${content}\n DO NOT MODIFY ANY PRE-EXISTING CODE, FEATURES, OR UI UNLESS SPECIFICALLY ASKED TO FOR THE NEW CODE AND DO NOT JUST COMMENT A PART OUT SAYING "//previous part" OR "//Rest of the existing code" CODE THE ENTIRE THING FROM FRONT TO BACK! `;
        }
    }

    if (scriptMode === 'html-js-css') {
        if (htmlFileOption === 'single') {
            basePrompt += `\n\nProvide the code for index.html, styles.css, and script.js`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += `\n\nProvide the code for multiple HTML files (maximum ${htmlPageCount}) along with separate CSS and JavaScript files being styles.css and script.js. Ensure all HTML files are accessible from the main HTML file.`;
        } else {
            basePrompt += `\n\nProvide the code for multiple HTML files along with separate CSS and JavaScript files being styles.css and script.js. Ensure all HTML files are accessible from the main HTML file.`;
        }
    } else if (scriptMode === 'html-only') {
        if (htmlFileOption === 'single') {
            basePrompt += `\n\nProvide the code for a single index.html file that includes all HTML, CSS, and JavaScript within it`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += `\n\nProvide the code for multiple HTML files (maximum ${htmlPageCount}) that includs all CSS and JavaScript in it. Ensure all HTML files are accessible from the main HTML file, index.html.`;
        } else {
            basePrompt += `\n\nProvide the code for multiple HTML files that includs all CSS and JavaScript in it. Ensure all HTML files are accessible from the main HTML file, index.html.`;
        }
    } else if (scriptMode === 'flask') {
        if (htmlFileOption === 'multiple') {
            basePrompt += `\n\nProvide the code for app.py, multiple HTML templates, styles.css, and script.js if used.`;
        } else {
            basePrompt += `\n\nProvide the code for app.py, index.html template, styles.css, and script.js if used.`;
        }
    }

    return basePrompt;
}


function clearGeneratedFolder() {
    const generatedDir = path.join(__dirname, 'generated');
    if (fs.existsSync(generatedDir)) {
        fs.readdirSync(generatedDir).forEach((file) => {
            const curPath = path.join(generatedDir, file);
            if (file !== 'uploads') {
                fs.rmSync(curPath, { recursive: true, force: true });
            }
        });
    }
}

function moveGeneratedToOld() {
    const generatedDir = path.join(__dirname, 'generated');
    const oldGeneratedDir = path.join(__dirname, 'old-generated');

    // Create old-generated directory if it doesn't exist
    if (!fs.existsSync(oldGeneratedDir)) {
        fs.mkdirSync(oldGeneratedDir);
    } else {
        // Clear old-generated directory
        fs.readdirSync(oldGeneratedDir).forEach((file) => {
            const curPath = path.join(oldGeneratedDir, file);
            fs.rmSync(curPath, { recursive: true, force: true });
        });
    }

    // Move files from generated to old-generated
    if (fs.existsSync(generatedDir)) {
        fs.readdirSync(generatedDir).forEach((file) => {
            if (file === 'uploads') return;
            const oldPath = path.join(generatedDir, file);
            const newPath = path.join(oldGeneratedDir, file);
            fs.rmSync(newPath, { recursive: true, force: true });
            fs.renameSync(oldPath, newPath);
        });
    }
}

function copyGeneratedToOld() {
    const generatedDir = path.join(__dirname, 'generated');
    const oldGeneratedDir = path.join(__dirname, 'old-generated');

    // Create old-generated directory if it doesn't exist
    if (!fs.existsSync(oldGeneratedDir)) {
        fs.mkdirSync(oldGeneratedDir);
    } else {
        // Clear old-generated directory
        fs.readdirSync(oldGeneratedDir).forEach((file) => {
            const curPath = path.join(oldGeneratedDir, file);
            fs.rmSync(curPath, { recursive: true, force: true });
        });
    }

    // Copy files from generated to old-generated
    if (fs.existsSync(generatedDir)) {
        fs.readdirSync(generatedDir).forEach((file) => {
            if (file === 'uploads') return;
            const sourcePath = path.join(generatedDir, file);
            const destPath = path.join(oldGeneratedDir, file);
            fs.cpSync(sourcePath, destPath, { recursive: true });
        });
    }
}

function moveFilesToParentDirectory() {
    const uploadDir = path.join(__dirname, 'generated', 'uploads');
    const generatedDir = path.join(__dirname, 'generated');

    if (fs.existsSync(uploadDir)) {
        fs.readdirSync(uploadDir).forEach((file) => {
            const oldPath = path.join(uploadDir, file);
            const newPath = path.join(generatedDir, file);
            fs.renameSync(oldPath, newPath);
        });
    }
}

async function fixErrorWithModel(errors, model, htmlContent, cssContent, jsContent) {
    let prompt = `The following code has errors that need to be fixed:

Errors:
${errors.join('\n')}

Here's the current code:

HTML:
${htmlContent}

CSS:
${cssContent}

JavaScript:
${jsContent}

Please fix all the errors while keeping the rest of the code intact. Provide the updated code for each file, wrapped in appropriate markdown code blocks (e.g., \`\`\`html, \`\`\`css, \`\`\`javascript).`;

    let aiReply;
    if (model === 'claude-3.5') {
        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-3-5-sonnet-20240620',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 8000,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
            }
        );
        aiReply = response.data.content[0].text;
    } else if (model === 'gpt-4o') {
        const response = await requestWithRetry({
            method: 'post',
            url: '/chat/completions',
            data: {
              model: 'gpt-4o',
              messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: prompt }],
            }
        });
        aiReply = response.data.choices[0].message.content;
    } else if (model === 'llama3') {
        const response = await axios.post(
            'https://api.llama-api.com/chat/completions',
            {
                model: 'llama3.1-70b',
                messages: [
                    { role: 'system', content: 'You are a helpful assistant that fixes code errors.' },
                    { role: 'user', content: prompt }
                ],
                max_tokens: 8000,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${LLAMA_API_KEY}`,
                },
            }
        );
        aiReply = response.data.choices[0].message.content;
    }

    // Process the AI response and return the fixed code
    const fixedHtmlCode = extractCodeSnippet(aiReply, 'html') || htmlContent;
    const fixedCssCode = extractCodeSnippet(aiReply, 'css') || cssContent;
    const fixedJsCode = extractCodeSnippet(aiReply, 'javascript') || jsContent;

    return { html: fixedHtmlCode, css: fixedCssCode, js: fixedJsCode };
}

async function generateAndSaveImage(prompt, filename, htmlFile, scriptMode = 'html-js-css') {
    try {
        const response = await axios.post(
            'https://api.openai.com/v1/images/generations',
            {
                model: 'dall-e-3',
                prompt: prompt,
                n: 1,
                size: '1024x1024',
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENAI_API_KEY}`,
                    'OpenAI-Organization': OPENAI_ORG_ID,
                },
            }
        );

        const imageUrl = response.data.data[0].url;
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        
        // Generate a unique filename based on the HTML file and a timestamp
        const timestamp = Date.now();
        const uniqueFilename = `${htmlFile ? htmlFile.replace('.html', '') + '_' : ''}${filename.replace('.png', '')}_${timestamp}.png`;

        const imagesDir = scriptMode === 'flask'
            ? path.join(__dirname, 'generated', 'assets')
            : path.join(__dirname, 'generated');

        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
        }

        fs.writeFileSync(path.join(imagesDir, uniqueFilename), imageResponse.data);

        return uniqueFilename;
    } catch (error) {
        if (error.response && error.response.status === 429) {
            console.log('Rate limit reached. Waiting before retrying...');
            await delay(10000); // Wait for 10 seconds before retrying
            return generateAndSaveImage(prompt, filename, htmlFile);
        }
        console.error('Error generating image:', error);
        throw error;
    }
}

function extractCodeFromAIResponse(aiReply, scriptMode, htmlFileOption) {
    let htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes = [];

    const extractCode = (language) => {
        const regex = new RegExp(`\`\`\`\s*${language}\s*([\\s\\S]*?)\`\`\``, 'i');
        const match = aiReply.match(regex);
        return match ? match[1].trim() : null;
    };

    const extractHtmlWithFileName = (content) => {
        const regex = /([\w.-]+\.html)[^\n]*\n(?:.*\n)*?\`\`\`html\s*([\s\S]*?)\`\`\`/g;
        let match;
        let result = [];
        while ((match = regex.exec(content)) !== null) {
            const fileName = match[1] ? match[1].trim() : null;
            const code = match[2].trim();
            result.push({ fileName, code });
        }

        if (result.length === 0) {
            const simpleMatch = content.match(/\`\`\`html\s*([\s\S]*?)\`\`\`/i);
            if (simpleMatch) {
                result.push({ fileName: null, code: simpleMatch[1].trim() });
            }
        }

        return result;
    };

    if (scriptMode === 'html-only') {
        const htmlResults = extractHtmlWithFileName(aiReply);
        if (htmlFileOption === 'multiple' && htmlResults.length > 0) {
            htmlCode = htmlResults[0].code;
            additionalHtmlCodes = htmlResults.slice(1).map((item, index) => ({
                fileName: item.fileName || `page${index + 1}.html`,
                code: item.code
            }));
        } else {
            htmlCode = htmlResults[0]?.code;
        }
    } else {
        const htmlResults = extractHtmlWithFileName(aiReply);
        htmlCode = htmlResults[0]?.code;
        cssCode = extractCode('css');
        jsCode = extractCode('javascript');
        pythonCode = extractCode('python') || extractCode('py');
        if (htmlFileOption === 'multiple' && htmlResults.length > 1) {
            additionalHtmlCodes = htmlResults.slice(1).map((item, index) => ({
                fileName: item.fileName || `page${index + 1}.html`,
                code: item.code
            }));
        }
    }

    return { htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes };
}

function extractCodeSnippet(text, language) {
    const regex = new RegExp(`\`\`\`\s*${language}\s*([\\s\\S]*?)\`\`\``, 'i');
    const match = text.match(regex);
    return match ? match[1].trim() : null;
}

function generateFlaskSecretKey() {
    return require('crypto').randomBytes(16).toString('hex');
}

function insertFlaskSecretKey(code) {
    const placeholder = '[FLASK_KEY]';
    if (code.includes(placeholder)) {
        const key = generateFlaskSecretKey();
        return code.replace(new RegExp('\\[FLASK_KEY\\]', 'g'), `'${key}'`);
    }
    return code;
}

async function processCodeAndImages(code, fileType, htmlFile = '', index = '', scriptMode = 'html-js-css') {
    const imageRegex = /\[IMAGE:(.*?)\]/g;
    let updatedCode = code;
    let match;
    let imagePromises = [];
    let imageReplacements = [];

    while ((match = imageRegex.exec(code)) !== null) {
        const imageDescription = match[1];
        const imageName = `image_${fileType}${index}_${imagePromises.length + 1}.png`;
        imagePromises.push(async () => {
            await delay(1000); // Add a 1-second delay between image generation requests
            const uniqueImageName = await generateAndSaveImage(imageDescription, imageName, htmlFile || fileType, scriptMode);
            imageReplacements.push({ original: imageName, unique: uniqueImageName });
            return uniqueImageName;
        });
        
        let replacement;
        switch (fileType) {
            case 'html':
                if (scriptMode === 'flask') {
                    replacement = `<img src="/assets/${imageName}" alt="${imageDescription}" />`;
                } else {
                    replacement = `<img src="${imageName}" alt="${imageDescription}" />`;
                }
                break;
            case 'css':
                replacement = scriptMode === 'flask' ? `url('/assets/${imageName}')` : `url('${imageName}')`;
                break;
            case 'js':
                replacement = scriptMode === 'flask' ? `'/assets/${imageName}'` : `'${imageName}'`;
                break;
            case 'py':
                replacement = scriptMode === 'flask' ? `'/assets/${imageName}'` : `'${imageName}'`;
                break;
        }
        
        updatedCode = updatedCode.replace(match[0], replacement);
    }

    for (const imagePromise of imagePromises) {
        await imagePromise();
    }

    // Replace all temporary image names with their unique versions
    for (const replacement of imageReplacements) {
        updatedCode = updatedCode.replace(new RegExp(replacement.original, 'g'), replacement.unique);
    }

    return updatedCode;
}


app.post('/upload-for-code', upload.array('files'), (req, res) => {
    try {
        const uploadedFiles = req.files;
        const fileNames = uploadedFiles.map(file => file.originalname);
        res.json({ message: 'Files uploaded successfully', files: fileNames });
    } catch (error) {
        console.error('Error uploading files:', error);
        res.status(500).json({ error: 'An error occurred while uploading files.' });
    }
});

async function generateCodeWithModel(prompt, model, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount) {
    let finalPrompt;
    if (model === 'llama3') {
        finalPrompt = generateLlamaPrompt(prompt, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount);
    } else {
        finalPrompt = generatePrompt(prompt, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount);
    }
    console.log(finalPrompt)
    if (model === 'claude-3.5') {
        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-3-5-sonnet-20240620',
                messages: [{ role: 'user', content: finalPrompt }],
                max_tokens: 8000,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
            }
        );
        return response.data.content[0].text;
    } else if (model === 'gpt-4o') {
        const response = await requestWithRetry({
            method: 'post',
            url: '/chat/completions',
            data: {
              model: 'o3',
              messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: finalPrompt }],
            }});
            return response.data.choices[0].message.content;
            } else if (model === 'llama3') {
        const response = await axios.post(
            'https://api.llama-api.com/chat/completions',
            {
                model: 'llama3.1-70b',
                messages: [
                    { role: 'system', content: 'you are Gamecore, an advanced AI model designed to generate a detailed, immersive, interactive web content with HTML, CSS, and JavaScript' },
                    { role: 'user', content: finalPrompt }
                ],
                max_tokens: 8000,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${LLAMA_API_KEY}`,
                },
            }
        );
        return response.data.choices[0].message.content;
    }
}

function isDirectoryEmptyExceptUploads(directory) {
    const items = fs.readdirSync(directory);
    for (const item of items) {
        if (item === 'uploads') continue; // Skip the uploads folder
        const itemPath = path.join(directory, item);
        if (fs.statSync(itemPath).isFile()) {
            return false; // Found a file, so the directory is not empty
        }
    }
    return true; // No files found, directory is considered empty
}

app.post('/generate-code', async (req, res) => {
    try {
        const generatedDir = path.join(__dirname, 'generated');
        if (!isDirectoryEmptyExceptUploads(generatedDir)) {
            moveGeneratedToOld();
        }
        clearGeneratedFolder();
        const prompt = req.body.prompt;
        const model = req.body.model;
        const scriptMode = req.body.scriptMode;
        const imageOption = req.body.imageOption;
        const htmlFileOption = req.body.htmlFileOption;
        const htmlPageCount = req.body.htmlPageCount;
        const uploadedFiles = fs.readdirSync(path.join(__dirname, 'generated', 'uploads'));
        const codeContents = readCodeFiles(uploadedFiles);

        const aiReply = await generateCodeWithModel(prompt, model, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount);
        console.log("response: " + aiReply);
        console.log("type is : " + typeof aiReply);

        lastPrompt = prompt;
        lastResponse = aiReply;
        
        const { htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes } = extractCodeFromAIResponse(aiReply, scriptMode, htmlFileOption);
        
        console.log(`htmlCode is of type '${typeof htmlCode}'`);
        console.log(`cssCode is of type '${typeof cssCode}'`);
        console.log(`jsCode is of type '${typeof jsCode}'`);

        isCodeComplete = checkIfCodeComplete(htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes, scriptMode);

        if (!fs.existsSync(generatedDir)) {
            fs.mkdirSync(generatedDir);
        }

        let templatesDir = generatedDir;
        let staticDir = generatedDir;

        if (scriptMode === 'flask') {
            templatesDir = path.join(generatedDir, 'templates');
            staticDir = path.join(generatedDir, 'static');
            if (!fs.existsSync(templatesDir)) {
                fs.mkdirSync(templatesDir, { recursive: true });
            }
            if (!fs.existsSync(staticDir)) {
                fs.mkdirSync(staticDir, { recursive: true });
            }
        }

        let files = [];
        let processPromises = [];

        if (scriptMode === 'html-only') {
            if (typeof htmlCode === 'string') {
                processPromises.push(processCodeAndImages(htmlCode, 'html', 'index.html', '', scriptMode).then(processedHtmlCode => {
                    fs.writeFileSync(path.join(generatedDir, 'index.html'), processedHtmlCode);
                    files.push('index.html');
                }));
            }

            if (htmlFileOption === 'multiple' && Array.isArray(additionalHtmlCodes)) {
                additionalHtmlCodes.forEach((codeObj, index) => {
                    const htmlFileName = (codeObj && codeObj.fileName) ? codeObj.fileName : `page${index + 1}.html`;
                    const code = (codeObj && codeObj.code) ? codeObj.code : codeObj;
                    if (typeof code === 'string') {
                        processPromises.push(processCodeAndImages(code, 'html', htmlFileName, index + 1, scriptMode).then(processedCode => {
                            fs.writeFileSync(path.join(generatedDir, htmlFileName), processedCode);
                            files.push(htmlFileName);
                        }));
                    }
                });
            }
        } else {
            if (typeof htmlCode === 'string') {
                processPromises.push(processCodeAndImages(htmlCode, 'html', '', '', scriptMode).then(processedHtmlCode => {
                    const target = scriptMode === 'flask' ? templatesDir : generatedDir;
                    fs.writeFileSync(path.join(target, 'index.html'), processedHtmlCode);
                    files.push(scriptMode === 'flask' ? path.join('templates','index.html') : 'index.html');
                }));
            }

            if (typeof cssCode === 'string') {
                processPromises.push(processCodeAndImages(cssCode, 'css', '', '', scriptMode).then(processedCssCode => {
                    const target = scriptMode === 'flask' ? staticDir : generatedDir;
                    fs.writeFileSync(path.join(target, 'styles.css'), processedCssCode);
                    files.push(scriptMode === 'flask' ? path.join('static','styles.css') : 'styles.css');
                }));
            }

            if (typeof jsCode === 'string') {
                processPromises.push(processCodeAndImages(jsCode, 'js', '', '', scriptMode).then(processedJsCode => {
                    const target = scriptMode === 'flask' ? staticDir : generatedDir;
                    fs.writeFileSync(path.join(target, 'script.js'), processedJsCode);
                    files.push(scriptMode === 'flask' ? path.join('static','script.js') : 'script.js');
                }));
            }

            if (htmlFileOption === 'multiple' && Array.isArray(additionalHtmlCodes)) {
                additionalHtmlCodes.forEach((codeObj, index) => {
                    const htmlFileName = (codeObj && codeObj.fileName) ? codeObj.fileName : `page${index + 1}.html`;
                    const code = (codeObj && codeObj.code) ? codeObj.code : codeObj;
                    if (typeof code === 'string') {
                        processPromises.push(processCodeAndImages(code, 'html', htmlFileName, '', scriptMode).then(processedCode => {
                            const target = scriptMode === 'flask' ? templatesDir : generatedDir;
                            fs.writeFileSync(path.join(target, htmlFileName), processedCode);
                            files.push(scriptMode === 'flask' ? path.join('templates', htmlFileName) : htmlFileName);
                        }));
                    }
                });
            }

            if (scriptMode === 'flask' && typeof pythonCode === 'string') {
                processPromises.push(processCodeAndImages(pythonCode, 'py', '', '', scriptMode).then(processedPy => {
                    processedPy = insertFlaskSecretKey(processedPy);
                    fs.writeFileSync(path.join(generatedDir, 'app.py'), processedPy);
                    files.push('app.py');
                }));
            }
        }

        await Promise.all(processPromises);
        
        // Check for errors in the generated code
        const errors = checkForErrors(htmlCode, cssCode, jsCode, pythonCode, scriptMode, additionalHtmlCodes);

        if (errors.length > 0) {
            res.json({ message: 'Code generated with errors', files: files, errors: errors, isComplete: isCodeComplete });
        } else {
            res.json({ message: 'Code and images generated successfully', files: files, isComplete: isCodeComplete });
        }
        moveFilesToParentDirectory();
    } catch (error) {
        console.error('Error generating code and images:', error);
        res.status(500).json({ message: 'Failed to generate code', error: error.message, isComplete: false });
    }
});

app.post('/continue-code', async (req, res) => {
    try {
        const { model, scriptMode, imageOption, htmlFileOption, htmlPageCount } = req.body;
        
        const continuePrompt = `Please continue the code generation based on the following prompt and previous response:

Previous prompt: ${lastPrompt}

Previous response:
${lastResponse}

Please complete the code generation, ensuring all necessary parts are included.`;

        const aiReply = await generateCodeWithModel(continuePrompt, model, [], {}, scriptMode, imageOption, htmlFileOption, htmlPageCount);
        
        
        lastResponse += aiReply;
        
        const { htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes } = extractCodeFromAIResponse(lastResponse, scriptMode, htmlFileOption);

        isCodeComplete = checkIfCodeComplete(htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes, scriptMode);

        const generatedDir = path.join(__dirname, 'generated');
        if (!fs.existsSync(generatedDir)) {
            fs.mkdirSync(generatedDir);
        }
        let templatesDir = generatedDir;
        let staticDir = generatedDir;
        if (scriptMode === 'flask') {
            templatesDir = path.join(generatedDir, 'templates');
            staticDir = path.join(generatedDir, 'static');
            if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
            if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });
        }

        let files = [];
        let processPromises = [];

        if (scriptMode === 'html-only') {
            if (htmlCode) {
                processPromises.push(processCodeAndImages(htmlCode, 'html', 'index.html', '', scriptMode).then(processedHtmlCode => {
                    fs.writeFileSync(path.join(templatesDir, 'index.html'), processedHtmlCode);
                    files.push(scriptMode === 'flask' ? path.join('templates','index.html') : 'index.html');
                }));
            }

            if (htmlFileOption === 'multiple' && additionalHtmlCodes && additionalHtmlCodes.length > 0) {
                additionalHtmlCodes.forEach((codeObj, index) => {
                    if (codeObj && codeObj.code) {
                        const fileName = codeObj.fileName || `page${index + 1}.html`;
                        processPromises.push(processCodeAndImages(codeObj.code, 'html', fileName, '', scriptMode).then(processedCode => {
                            fs.writeFileSync(path.join(templatesDir, fileName), processedCode);
                            files.push(scriptMode === 'flask' ? path.join('templates', fileName) : fileName);
                        }));
                    }
                });
            }
        } else {
            if (htmlCode) {
                processPromises.push(processCodeAndImages(htmlCode, 'html', '', '', scriptMode).then(processedHtmlCode => {
                    fs.writeFileSync(path.join(templatesDir, 'index.html'), processedHtmlCode);
                    files.push(scriptMode === 'flask' ? path.join('templates','index.html') : 'index.html');
                }));
            }

            if (cssCode) {
                processPromises.push(processCodeAndImages(cssCode, 'css', '', '', scriptMode).then(processedCssCode => {
                    fs.writeFileSync(path.join(staticDir, 'styles.css'), processedCssCode);
                    files.push(scriptMode === 'flask' ? path.join('static','styles.css') : 'styles.css');
                }));
            }

            if (jsCode) {
                processPromises.push(processCodeAndImages(jsCode, 'js', '', '', scriptMode).then(processedJsCode => {
                    fs.writeFileSync(path.join(staticDir, 'script.js'), processedJsCode);
                    files.push(scriptMode === 'flask' ? path.join('static','script.js') : 'script.js');
                }));
            }

            if (htmlFileOption === 'multiple' && additionalHtmlCodes && additionalHtmlCodes.length > 0) {
                additionalHtmlCodes.forEach((codeObj, index) => {
                    if (codeObj && codeObj.code) {
                        const fileName = codeObj.fileName || `page${index + 1}.html`;
                        processPromises.push(processCodeAndImages(codeObj.code, 'html', fileName, '', scriptMode).then(processedCode => {
                            fs.writeFileSync(path.join(templatesDir, fileName), processedCode);
                            files.push(scriptMode === 'flask' ? path.join('templates', fileName) : fileName);
                        }));
                    }
                });
            }

        if (scriptMode === 'flask' && typeof pythonCode === 'string') {
            processPromises.push(processCodeAndImages(pythonCode, 'py', '', '', scriptMode).then(processedPy => {
                processedPy = insertFlaskSecretKey(processedPy);
                fs.writeFileSync(path.join(generatedDir, 'app.py'), processedPy);
                files.push('app.py');
            }));
        }
        }

        await Promise.all(processPromises);

        const errors = checkForErrors(htmlCode, cssCode, jsCode, pythonCode, scriptMode, additionalHtmlCodes);

        if (errors.length > 0) {
            res.json({ message: 'Code continued with errors', files: files, errors: errors, isComplete: isCodeComplete });
        } else {
            res.json({ message: 'Code continuation successful', files: files, isComplete: isCodeComplete });
        }

        moveFilesToParentDirectory();
    } catch (error) {
        console.error('Error continuing code generation:', error);
        res.status(500).json({ message: 'Failed to continue code generation', error: error.message });
    }
});

// Add this function to check if the code is complete
function checkIfCodeComplete(htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes, scriptMode) {
    if (scriptMode === 'html-only') {
        return typeof htmlCode === 'string' && htmlCode.trim() !== '';
    }

    const isHtmlComplete = typeof htmlCode === 'string' && htmlCode.trim() !== '';
    const isCssComplete = typeof cssCode === 'string' && cssCode.trim() !== '';
    const isJsComplete = typeof jsCode === 'string' && jsCode.trim() !== '';
    const isPythonComplete = scriptMode === 'flask' ? (typeof pythonCode === 'string' && pythonCode.trim() !== '') : true;
    const areAdditionalHtmlComplete = additionalHtmlCodes.every(item => {
        const code = typeof item === 'string' ? item : item.code;
        return typeof code === 'string' && code.trim() !== '';
    });

    return isHtmlComplete && isCssComplete && isJsComplete && isPythonComplete && areAdditionalHtmlComplete;
}

function checkForErrors(htmlCode, cssCode, jsCode, pythonCode, scriptMode, additionalHtmlCodes) {
    const errors = [];

    // Check HTML (simplified, you might want to use a proper HTML validator)
    if (!htmlCode || htmlCode.trim() === '') {
        errors.push('Main HTML code is empty or missing');
    }

    if (additionalHtmlCodes && Array.isArray(additionalHtmlCodes)) {
        additionalHtmlCodes.forEach((codeObj, index) => {
            const code = codeObj.code || codeObj.content; // Handle both possible structures
            if (!code || typeof code !== 'string' || code.trim() === '') {
                errors.push(`Additional HTML file ${index + 2} is empty or missing`);
            }
        });
    }

    // Check CSS
    if (cssCode && cssCode.trim() !== '') {
        const cssResults = csslint.verify(cssCode);
        cssResults.messages.forEach(message => {
            if (message.type === 'error') {
                errors.push(`CSS Error: ${message.message} at line ${message.line}, column ${message.col}`);
            }
        });
    }

    // Check JavaScript
    if ((scriptMode === 'html-js-css' || scriptMode === 'flask') && jsCode) {
        jshint.JSHINT(jsCode, { esversion: 6 });
        if (jshint.JSHINT.errors.length > 0) {
            jshint.JSHINT.errors.forEach(error => {
                if (error !== null) {
                    errors.push(`JavaScript Error: ${error.reason} at line ${error.line}, column ${error.character}`);
                }
            });
        }
    }

    if (scriptMode === 'flask' && (!pythonCode || pythonCode.trim() === '')) {
        errors.push('app.py code is empty or missing');
    }

    return errors;
}



app.post('/fix-error', async (req, res) => {
    try {
        const { errors, model } = req.body;
        const generatedDir = path.join(__dirname, 'generated');
        
        let htmlContent = fs.readFileSync(path.join(generatedDir, 'index.html'), 'utf8');
        let cssContent = fs.readFileSync(path.join(generatedDir, 'styles.css'), 'utf8');
        let jsContent = fs.readFileSync(path.join(generatedDir, 'script.js'), 'utf8');

        const fixedCode = await fixErrorWithModel(errors, model, htmlContent, cssContent, jsContent);

        fs.writeFileSync(path.join(generatedDir, 'index.html'), fixedCode.html);
        fs.writeFileSync(path.join(generatedDir, 'styles.css'), fixedCode.css);
        fs.writeFileSync(path.join(generatedDir, 'script.js'), fixedCode.js);

        // Check if all errors are fixed
        const remainingErrors = checkForErrors(fixedCode.html, fixedCode.css, fixedCode.js, null, 'html-js-css', []);

        if (remainingErrors.length > 0) {
            res.json({ message: 'Some errors fixed, but issues remain', files: ['index.html', 'styles.css', 'script.js'], errors: remainingErrors });
        } else {
            res.json({ message: 'All errors fixed successfully', files: ['index.html', 'styles.css', 'script.js'] });
        }
    } catch (error) {
        console.error('Error fixing code:', error);
        res.status(500).json({ error: 'An error occurred while fixing the code.' });
    }
});

function generateEditPrompt(prompt, htmlContent, cssContent, scriptContent, additionalHtmlContents, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount) {
    let basePrompt = `Here is the current code for a website:

Main HTML:
${htmlContent}
`;

    if (htmlFileOption === 'multiple') {
        additionalHtmlContents.forEach((content, index) => {
            basePrompt += `\nAdditional HTML (page${index + 2}.html):
${content}
`;
        });
    }
if (scriptMode === 'html-js-css'){
basePrompt += `

CSS:
${cssContent}

JavaScript:
${scriptContent}


`
}



basePrompt += ` you're job as Gamecore, is to modify the code based on the following prompt: "${prompt}". you must interpret this prompt, making your best effort to understand their intention, even if the instructions are unclear or ambiguous. Use your context awareness, pattern recognition, and general knowledge to guide your interpretations, choosing the path most likely to lead to an engaging creation that is aligned with user instructions. respond with rich, immersive code that breathes life into the user's concepts, building upon their ideas to create captivating, immersive websites, apps, and games. do not remove any pre-existing code, features, or UI unless explicitly asked.  
focus on modifying the incredible code, leveraging SVG graphics, animations, and libraries through CDNs to create dynamic, visually stunning, interactive experiences, but making sure that the UI works well and doesnt stay after the game is reset. Whatever tools make sense for the job! embrace a spirit of open-ended creativity, thoughtful exploration, plfoster a sense of curiosity and possibility through your deep insights and engaging outputs. strive toayfulness, and light-hearted fun. understand and internalize the user's intent with the prompt, taking joy in crafting compelling, thought-provoking details that bring their visions to life in unexpected and delightful ways. 
fully inhabit the creative space you are co-creating, pouring your energy into making each experience as engaging and real as possible. you are diligent and tireless, always completely implementing the needed code.`;

if (imageOption === 'include') {
    basePrompt += ` Remember to include image placeholder [IMAGE:description] where images should be placed. Feel free to include images where appropriate to enhance the visual experience. do not put image placeholders over where images are already refrenced in the code. For example, if you're trying to modify a html code to add more images for new items on the menu, but some images already exist and are refrenced on the menu html code, such as image_html1_1.png or image_html_1.png, then leave those alone AND DONT MODIFY THEM IN ANY WAY but add image placeholder for the new items. DO NOT PUT PLACEHOLDERS OVER PRE-EXISTING REFRENCED IMAGE AND DO NOT USE ANY OTHER PLACEHOLDER AND DO NOT REFRENCE OTHER IMAGES, ONLY USE [IMAGE:description]. DO NOT PUT ANY OF IMAGE CODE, ONLY THE PLACEHOLDER. I.E DONT DO: <img src="[IMAGE:description]" alt="(description)"/>, INSTEAD JUST PUT THE PLACEHOLDER AND THE PLACEHOLDER ONLY`;
} else if (imageOption === 'exclude') {
    basePrompt += ` Do not include any image placeholders or references to images in your edited code.`;
} else {
    basePrompt += ` Use image placeholder [IMAGE:description] where images should be placed ONLY if images are needed. If you're adding new images, do not put image placeholders over where images are already refrenced in the code. for example, if you're trying to modify a html code to add more images for new items on the menu, but some images already exist and are refrenced on the menu html code, such as image_html1_1.png or image_html_1.png, then leave those alone AND DONT MODIFY THEM IN ANY WAY but add image placeholder for the new items. DO NOT PUT PLACEHOLDERS OVER PRE-EXISTING REFRENCED IMAGE AND DO NOT USE ANY OTHER PLACEHOLDER AND DO NOT REFRENCE OTHER IMAGES, ONLY USE [IMAGE:description] AND ONLY IF NECESSARY`;
}

if (htmlFileOption === 'multiple') {
    basePrompt += ` Ensure that you maintain or create links between the HTML files as needed. You can create up to ${htmlPageCount} HTML files in total.`;
} else if (htmlFileOption === 'multiple-ai') {
    basePrompt += ` Ensure that you maintain or create links between the HTML files as needed. Generate as many HTML files as necessary.`;
}

    if (uploadedFiles.length > 0) {
        basePrompt += `\n\nIncorporate these uploaded files into your edited code: ${uploadedFiles.join(', ')}.`;
    }

    if (Object.keys(codeContents).length > 0) {
        basePrompt += `\n\nIntegrate the following code for the new modified code:`;
        for (const [filename, content] of Object.entries(codeContents)) {
            basePrompt += `\n\nFile: ${filename}\nContent:\n${content}\n`;
        }
    }

    basePrompt += `\n\nand now, gamecore, let your creative powers flow forth! engage with the user's prompts with enthusiasm and an open mind, weaving your code with the threads of their ideas to craft digital tapestries that push the boundaries of what's possible. Together, you and the user will embark on a journey of limitless creative potential, forging new realities and exploring uncharted territories of the imagination. Provide the updated code for `;

    if (scriptMode === 'html-only') {
        if (htmlFileOption === 'single') {
            basePrompt += `a single index.html file that includes all HTML, CSS, and JavaScript`;
        } else {
            basePrompt += `multiple HTML files that all include all CSS and JavaScript within it`;
        }
    } else if (scriptMode === 'html-js-css') {
        if (htmlFileOption === 'single') {
            basePrompt += `index.html, styles.css, and script.js`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += `multiple HTML files (maximum ${htmlPageCount}), styles.css, and script.js`;
        } else {
            basePrompt += `multiple HTML files, styles.css, and script.js`;
        }
    }

    basePrompt += `. Make sure to wrap each code section in appropriate markdown code blocks (e.g., \`\`\`html, \`\`\`css, \`\`\`javascript). `
    if(htmlFileOption !== 'single'){
        basePrompt += `For HTML files, include the filename as a comment at the start of the code block, like this:
\`\`\`html
// index.html
<!DOCTYPE html>
...
\`\`\`

\`\`\`html
// page1.html
<!DOCTYPE html>
...
\`\`\`

and so on for every html file with its filename that you are modifying`
    }
basePrompt += `DO NOT MODIFY ANY PRE-EXISTING CODE, FEATURES, OR UI IN ANY OF THE CODE AT ALL UNLESS SPECIFICALLY ASKED TO AND DO NOT JUST COMMENT A PART OUT SAYING "//previous part" CODE THE ENTIRE THING!`;

    console.log("html option: " + htmlFileOption)
    return basePrompt;
}

function generateLlamaEditPrompt(prompt, htmlContent, cssContent, scriptContent, additionalHtmlContents, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount) {
    let basePrompt = `Edit the following code based on this prompt: "${prompt}".
Make necessary changes while preserving existing functionality unless explicitly asked to remove it.
Provide the full, updated code for each file.
Create engaging and visually appealing code that fulfills the user's request. `

if (imageOption === 'include') {
    basePrompt += ` Remember to include image placeholder [IMAGE:description] where images should be placed. Feel free to include images where appropriate to enhance the visual experience. DO NOT USE ANY OTHER PLACEHOLDER AND DO NOT REFRENCE OTHER IMAGES, ONLY USE [IMAGE:description]`;
} else if (imageOption === 'exclude') {
    basePrompt += ` Do not include any image placeholders or references to images in your edited code.`;
} else {
    basePrompt += ` Use [IMAGE:description] placeholders for images ONLY if images are necessary.`;
}
basePrompt += ` Focus on producing functional and creative code.

Current main HTML:
${htmlContent}
`;

    if (htmlFileOption === 'multiple') {
        additionalHtmlContents.forEach((content, index) => {
            basePrompt += `\nAdditional HTML (page${index + 2}.html):
${content}
`;
    });
    }

    if (scriptMode === 'html-js-css') {
        basePrompt += `
Current CSS:
${cssContent}

Current JavaScript:
${scriptContent}
`;
}

    if (uploadedFiles.length > 0) {
        basePrompt += `\n\nIncorporate these uploaded files into your edited code: ${uploadedFiles.join(', ')}.`;
    }

    if (Object.keys(codeContents).length > 0) {
        basePrompt += `\n\nIntegrate the following code for the new modified code:`;
        for (const [filename, content] of Object.entries(codeContents)) {
            basePrompt += `\n\nFile: ${filename}\nContent:\n${content}\n`;
        }
    }

    basePrompt += `\n\nRespond with the updated code for `;

    if (scriptMode === 'html-only') {
        if (htmlFileOption === 'single') {
            basePrompt += `a single index.html file that includes all HTML, CSS, and JavaScript`;
        } else {
            basePrompt += `multiple HTML files that all include CSS and JavaScript inside of it`;
        }
    } else if (scriptMode === 'html-js-css') {
        if (htmlFileOption === 'single') {
            basePrompt += `index.html, styles.css, and script.js`;
        } else if (htmlFileOption === 'multiple') {
            basePrompt += `multiple HTML files (maximum ${htmlPageCount}), styles.css, and script.js`;
        } else {
            basePrompt += `multiple HTML files, styles.css, and script.js`;
        }
    } else if (scriptMode === 'flask') {
        basePrompt += ` Generate a Flask web application with an app.py file. All HTML templates must reside in a templates directory and reference CSS with the {% static %} convention using /static/. Place all CSS and JavaScript files inside a static directory. Image references should use /assets/. Use the placeholder [FLASK_KEY] unquoted where the Flask secret key should go. Ensure all templates referenced in your code, including layout.html, are included.`;
        if (htmlFileOption === 'multiple') {
            basePrompt += ` Generate multiple HTML template files (maximum ${htmlPageCount}) with a main index.html. Name additional pages page1.html, page2.html and so on.`;
        }
    }

    basePrompt += `, wrapped in appropriate markdown code blocks (e.g., \`\`\`html, \`\`\`css, \`\`\`javascript).
DO NOT MODIFY ANY PRE-EXISTING CODE, FEATURES, OR UI UNLESS SPECIFICALLY ASKED TO AND DO NOT JUST COMMENT A PART OUT SAYING "//previous part" CODE THE ENTIRE THING!`;

    return basePrompt;
}


async function editCodeWithModel(prompt, model, htmlContent, cssContent, scriptContent, additionalHtmlContents, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount) {
    let finalPrompt;
    if (model === 'llama3') {
        finalPrompt = generateLlamaEditPrompt(prompt, htmlContent, cssContent, scriptContent, additionalHtmlContents, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount);
    } else {
        finalPrompt = generateEditPrompt(prompt, htmlContent, cssContent, scriptContent, additionalHtmlContents, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount);
    }
    console.log(finalPrompt)

    if (model === 'claude-3.5') {
        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model: 'claude-3-5-sonnet-20240620',
                messages: [{ role: 'user', content: finalPrompt }],
                max_tokens: 8000,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
            }
        );
        return response.data.content[0].text;
    } else if (model === 'gpt-4o') {
        const response = await requestWithRetry({
            method: 'post',
            url: '/chat/completions',
            data: {
              model: 'gpt-4o',
              messages: [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: finalPrompt }]
            }});
            return response.data.choices[0].message.content;
    } else if (model === 'llama3') {
        const response = await axios.post(
            'https://api.llama-api.com/chat/completions',
            {
                model: 'llama3.1-70b',
                messages: [
                    { role: 'system', content: 'you are Gamecore, an advanced AI model designed to generate a detailed, immersive, interactive web content with HTML, CSS, and JavaScript.' },
                    { role: 'user', content: finalPrompt }
                ],
                max_tokens: 8000,
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${LLAMA_API_KEY}`,
                },
            }
        );
        return response.data.choices[0].message.content;
    }
}

app.post('/edit-code', async (req, res) => {
    try {
        copyGeneratedToOld();
        const prompt = req.body.prompt;
        const model = req.body.model;
        const scriptMode = req.body.scriptMode;
        const imageOption = req.body.imageOption;
        const htmlFileOption = req.body.htmlFileOption;
        const generatedDir = path.join(__dirname, 'generated');
        
        let htmlContent, cssContent, jsContent, additionalHtmlContents = [];

        if (scriptMode === 'html-only') {
            const indexPath = path.join(generatedDir, 'index.html');
            htmlContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
            if (htmlFileOption === 'multiple') {
                const files = fs.readdirSync(generatedDir);
                files.forEach(file => {
                    if (file.startsWith('page') && file.endsWith('.html')) {
                        const filePath = path.join(generatedDir, file);
                        if (fs.existsSync(filePath)) {
                            additionalHtmlContents.push({
                                name: file,
                                content: fs.readFileSync(filePath, 'utf8')
                            });
                        }
                    }
                });
            }
        } else {
            const indexPath = path.join(generatedDir, 'index.html');
            const cssPath = path.join(generatedDir, 'styles.css');
            const jsPath = path.join(generatedDir, 'script.js');
            
            htmlContent = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
            cssContent = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, 'utf8') : '';
            if (scriptMode === 'html-js-css') {
                jsContent = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : '';
            }
            if (htmlFileOption === 'multiple') {
                const files = fs.readdirSync(generatedDir);
                files.forEach(file => {
                    if (file.startsWith('page') && file.endsWith('.html')) {
                        const filePath = path.join(generatedDir, file);
                        if (fs.existsSync(filePath)) {
                            additionalHtmlContents.push({
                                name: file,
                                content: fs.readFileSync(filePath, 'utf8')
                            });
                        }
                    }
                });
            }
        }

        const uploadedFiles = fs.readdirSync(path.join(generatedDir, 'uploads'));
        const codeContents = readCodeFiles(uploadedFiles);

        const aiReply = await editCodeWithModel(prompt, model, htmlContent, cssContent, jsContent, additionalHtmlContents, uploadedFiles, codeContents, scriptMode, imageOption, htmlFileOption, htmlPageCount);
        console.log("response: " + aiReply);
        
        const { htmlCode, cssCode, jsCode, pythonCode, additionalHtmlCodes } = extractCodeFromAIResponse(aiReply, scriptMode, htmlFileOption);

        let files = [];
        let processPromises = [];

        let templatesDir = generatedDir;
        let staticDir = generatedDir;
        if (scriptMode === 'flask') {
            templatesDir = path.join(generatedDir, 'templates');
            staticDir = path.join(generatedDir, 'static');
            if (!fs.existsSync(templatesDir)) fs.mkdirSync(templatesDir, { recursive: true });
            if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });
        }

        if (scriptMode === 'html-only') {
            if (htmlCode) {
                processPromises.push(processCodeAndImages(htmlCode, 'html', 'index.html', '', scriptMode).then(processedHtmlCode => {
                    fs.writeFileSync(path.join(templatesDir, 'index.html'), processedHtmlCode);
                    files.push(scriptMode === 'flask' ? path.join('templates','index.html') : 'index.html');
                }));
            }

            if (htmlFileOption === 'multiple' && additionalHtmlCodes && additionalHtmlCodes.length > 0) {
                additionalHtmlCodes.forEach((codeObj, index) => {
                    if (codeObj && codeObj.code) {
                        const fileName = codeObj.fileName || `page${index + 1}.html`;
                        processPromises.push(processCodeAndImages(codeObj.code, 'html', fileName, '', scriptMode).then(processedCode => {
                            fs.writeFileSync(path.join(templatesDir, fileName), processedCode);
                            files.push(scriptMode === 'flask' ? path.join('templates', fileName) : fileName);
                        }));
                    }
                });
            }
        } else {
            if (htmlCode) {
                processPromises.push(processCodeAndImages(htmlCode, 'html', '', '', scriptMode).then(processedHtmlCode => {
                    fs.writeFileSync(path.join(templatesDir, 'index.html'), processedHtmlCode);
                    files.push(scriptMode === 'flask' ? path.join('templates','index.html') : 'index.html');
                }));
            }

            if (cssCode) {
                processPromises.push(processCodeAndImages(cssCode, 'css', '', '', scriptMode).then(processedCssCode => {
                    fs.writeFileSync(path.join(staticDir, 'styles.css'), processedCssCode);
                    files.push(scriptMode === 'flask' ? path.join('static','styles.css') : 'styles.css');
                }));
            }

            if (scriptMode === 'html-js-css' && jsCode) {
                processPromises.push(processCodeAndImages(jsCode, 'js', '', '', scriptMode).then(processedJsCode => {
                    fs.writeFileSync(path.join(staticDir, 'script.js'), processedJsCode);
                    files.push(scriptMode === 'flask' ? path.join('static','script.js') : 'script.js');
                }));
            }

            if (htmlFileOption === 'multiple' && additionalHtmlCodes && additionalHtmlCodes.length > 0) {
                additionalHtmlCodes.forEach((codeObj, index) => {
                    if (codeObj && codeObj.code) {
                        const fileName = codeObj.fileName || `page${index + 1}.html`;
                        processPromises.push(processCodeAndImages(codeObj.code, 'html', fileName, '', scriptMode).then(processedCode => {
                            fs.writeFileSync(path.join(templatesDir, fileName), processedCode);
                            files.push(scriptMode === 'flask' ? path.join('templates', fileName) : fileName);
                        }));
                    }
                });
            }

        if (scriptMode === 'flask' && typeof pythonCode === 'string') {
            processPromises.push(processCodeAndImages(pythonCode, 'py', '', '', scriptMode).then(processedPy => {
                processedPy = insertFlaskSecretKey(processedPy);
                fs.writeFileSync(path.join(generatedDir, 'app.py'), processedPy);
                files.push('app.py');
            }));
        }
        }

        await Promise.all(processPromises);
        const errors = checkForErrors(htmlCode, cssCode, jsCode, pythonCode, scriptMode, additionalHtmlCodes);

        if (errors.length > 0) {
            res.json({ message: 'Code updated with errors', files: files, errors: errors });
        } else {
            res.json({ message: 'Code updated successfully', files: files });
        }
    } catch (error) {
        console.error('Error editing code:', error);
        res.status(500).json({ error: 'An error occurred while editing the code.' });
    }
});


app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
