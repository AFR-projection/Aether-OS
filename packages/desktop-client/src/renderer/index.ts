const root = document.getElementById('root');
if (!root) throw new Error('Renderer root element is missing');

const heading = document.createElement('h1');
heading.textContent = 'Aether Cloud OS';
root.appendChild(heading);
