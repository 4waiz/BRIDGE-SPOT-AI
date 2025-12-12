update_images();
update_text();

async function refresh(type) {
    document.getElementById('spinner').style.display = 'block';
    await analyze(type);
    update_images();
    update_text();
    document.getElementById('spinner').style.display = 'none';
}


async function analyze(type) {
    const url = "/analyzefromspot?source=" + type;
    await fetch(url)
        .then(async response => {
            if (!response.ok) {
                text = await response.text()
                alert(text)
                throw new Error('Network response was not ok ' + response.statusText);
            }
            return response.text()
        })
        .then(data => {
            console.log(data); // handle the response data
        })
        .catch(error => {
            console.error('There was an error!', error);
        });
}

function update_images() {
    addTimestampToImageSrc("latest_image_1")
    addTimestampToImageSrc("latest_image_2")
    addTimestampToImageSrc("latest_image_3")
}


function update_text() {
    update_text_element("latest_text_1")
    update_text_element("latest_text_2")
    update_text_element("latest_text_3")
}

function addTimestampToImageSrc(img_id) {
    // Select the image element by its id
    const imgElement = document.getElementById(img_id);

    // Get the current src
    const src = imgElement.getAttribute('src');

    // Define a delimiter based on whether the src already has query parameters
    const delimiter = src.includes('?') ? '&' : '?';

    // Generate the timestamp
    const timestamp = Date.now();

    // Create the new src with the timestamp query parameter
    const newSrc = `${src}${delimiter}timestamp=${timestamp}`;

    // Set the new src
    imgElement.setAttribute('src', newSrc);
}

function update_text_element(text_id) {
    const text_element = document.getElementById(text_id);
    const tick_element = document.getElementById("icon_container_" + text_id).querySelector(".tick");
    const cross_element = document.getElementById("icon_container_" + text_id).querySelector(".cross");
    const img_element = document.getElementById("latest_image_" + text_id.split("_")[2]);
    const timestamp = Date.now();
    const url = "/latest/HSSE/" + text_id + ".json?t=" + timestamp
    fetch(url)
        .then(response => response.json())
        .then(json_data => {
            text_element.innerHTML = json_data.output_text;
            const output_boolean = json_data.output_boolean;
            if (output_boolean === "OK") {
                // Display the tick image and hide the cross image
                tick_element.style.display = "block";
                cross_element.style.display = "none";
                // Add green glow
                img_element.classList.add('glow-green');
                img_element.classList.remove('glow-red');
            } else {
                // Display the cross image and hide the tick image
                tick_element.style.display = "none";
                cross_element.style.display = "block";
                // Add red glow
                img_element.classList.add('glow-red');
                img_element.classList.remove('glow-green');
            }
            return json_data;
        })
        .then(data => {
            console.log(data);
        })
        .catch(error => console.error('Error loading JSON:', error));
}


// Add event listeners to image containers to open in full screen
document.querySelectorAll('.image-container').forEach(container => {
    container.addEventListener('click', () => {
        const imgId = container.querySelector('img').id;
        openFullscreen(imgId);
    });
});

function openFullscreen(img_id) {
    // Get the image element by id
    const imgElement = document.getElementById(img_id);
    
    // Get the image source
    const imgSrc = imgElement.getAttribute('src');

    // Set the fullscreen image source
    const fullscreenImgElement = document.getElementById('fullscreen_image');
    fullscreenImgElement.setAttribute('src', imgSrc);

    // Show the fullscreen container
    document.getElementById('fullscreen_container').style.display = 'flex';
}

function closeFullscreen() {
    // Hide the fullscreen container
    document.getElementById('fullscreen_container').style.display = 'none';
}