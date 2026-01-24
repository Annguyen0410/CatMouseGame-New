# CatMouseGame

### How to run the game locally
Make sure you have Git, Node and NPM installed. Then, clone this repo to your PC using a terminal. In your terminal, go to the game files and in the main folder run
`npm start`

Then go to 127.0.0.1:3030 to play your game in your web browser. Leave the terminal open while you play the game.

Quick review: HTML generates the content on each webpage. CSS controls the UI on each webpage. Javascript is like the brain and controls how the game actually works.


### database.js
This script controls how new accounts are stored. This script stores the username and the password associated with the username.

### deploy.sh
This script uses npm to run the game locally on your computer so this script starts the game.

### server.js
This script is the main code that controls how the game works. From completing terminals, to attacking etc.

### In the public folder:
### index.html
This script has all the code that generates the content that's shown on each page of the website.

### style.css
This script has all the css code that controls what the UI on each page of the website looks like.

### In public/js:
### game.js
This script generates and loads the map. It randomly loads the spawn location of the players, and the locations of the terminals.

### main.js
This script controls the main menu screen and the find lobby screen.

Bugs to fix:

* Terminals spawn a little too close together
* The timers aren't ticking at regular time. A 30 second timer ticks extra slow and takes 2 minutes to finish
* If you're a mouse and the cat kills you, there's no "You Died" screen

Things to do:
* Add music & sound effects
* Make artwork
* Self host this on a website or host this website using Render

Optional things to do:
* Add more characters & add a character selection screen
* 
