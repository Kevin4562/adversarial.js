import {fgsmTargeted, bimTargeted, jsmaOnePixel, jsma, cw} from './adversarial.js';
import {MNIST_CLASSES, GTSRB_CLASSES, CIFAR_CLASSES, IMAGENET_CLASSES} from './class_names.js';

/************************************************************************
* Global constants
************************************************************************/

const $ = query => document.querySelector(query);

const MNIST_CONFIGS = {
  'fgsmTargeted': {ε: 0.2},  // Targeted FGSM works slightly better on MNIST with higher distortion
  'bimTargeted': {iters: 20},  // Targeted BIM works slightly better on MNIST with more iterations (pushes misclassification confidence up)
};

const GTSRB_CONFIGS = {
  'bimTargeted': {iters: 50},  // Needs more iterations to work well
  'jsmaOnePixel': {ε: 75},  // Works well with the same settings as CIFAR-10
};

const CIFAR_CONFIGS = {
  'fgsm': {ε: 0.05},  // 0.1 L_inf perturbation is too visible in color
  'jsmaOnePixel': {ε: 75},  // JSMA one-pixel on CIFAR-10 requires more ~3x pixels than MNIST
  'jsma': {ε: 75},  // JSMA on CIFAR-10 also requires more ~3x pixels than MNIST
  'cw': {c: 1, λ: 0.05}  // Tried to minimize distortion, but not sure it worked
};

const IMAGENET_CONFIGS = {
  'fgsm': {ε: 0.05},  // 0.1 L_inf perturbation is too visible in color
  'fgsmTargeted': {loss: 1},  // The 2nd loss function is too heavy for ImageNet
  'jsmaOnePixel': {ε: 75},  // This is unsuccessful. I estimate that it requires ~50x higher ε than CIFAR-10 to be successful on ImageNet, but that is too slow
  'cw': {κ: 5, c: 1, λ: 0.05}  // Generate higher confidence adversarial examples, and minimize distortion
};

/************************************************************************
* Load Models
************************************************************************/

/****************************** Load MNIST ******************************/

let mnistModel;
async function loadMnistModel() {
  if (mnistModel !== undefined) { return; }
  mnistModel = await tf.loadLayersModel('data/mnist/mnist_dnn.json');
}

/****************************** Load CIFAR-10 ******************************/

let cifarModel;
async function loadCifarModel() {
  if (cifarModel !== undefined) { return; }
  cifarModel = await tf.loadLayersModel('data/cifar/cifar10_cnn.json');
}

/****************************** Load GTSRB ******************************/

let gtsrbModel;
async function loadGtsrbModel() {
  if (gtsrbModel !== undefined) { return; }
  gtsrbModel = await tf.loadLayersModel('data/gtsrb/gtsrb_cnn.json');
}

/****************************** Load ImageNet ******************************/

let imagenetModel;
async function loadImagenetModel() {
  if (imagenetModel !== undefined) { return; }
  imagenetModel = await mobilenet.load({version: 2, alpha: 1.0});

  // Monkey patch the mobilenet object to have a predict() method like a normal tf.LayersModel
  imagenetModel.predict = function (img) {
    return this.predictLogits(img).softmax();
  }

  // Also monkey patch the mobilenet object with a method to predict logits
  imagenetModel.predictLogits = function (img) {
    // Remove the first "background noise" logit
    // Copied from: https://github.com/tensorflow/tfjs-models/blob/708e3911fb01d0dfe70448acc3e8ca736fae82d3/mobilenet/src/index.ts#L232
    const logits1001 = this.model.predict(img);
    return logits1001.slice([0, 1], [-1, 1000]);
  }
}

/************************************************************************
* Attach Event Handlers
************************************************************************/

// On page load
window.addEventListener('load', resetAvailableAttacks);
window.addEventListener('load', showBanners);

// Model selection dropdown
$('#select-model').addEventListener('change', removeLeftOverlay);
$('#select-model').addEventListener('change', resetOnNewImage);
//$('#select-model').addEventListener('change', resetAttack);
$('#select-model').addEventListener('change', removeLeftOverlay);

// Predict button (original image)
$('#predict-original').addEventListener('click', predict);

// Target label dropdown
$('#select-target').addEventListener('change', resetAttack);

// Attack algorithm dropdown
$('#select-attack').addEventListener('change', resetAttack);

// Generate button
$('#generate-adv').addEventListener('click', generateAdv);
$('#generate-adv').addEventListener('click', removeBottomRightOverlay);

// Predict button (adversarial image)
$('#predict-adv').addEventListener('click', predictAdv);

// View noise / view image link
$('#view-noise').addEventListener('click', viewNoise);
$('#view-image').addEventListener('click', viewImage);

$('#image-selector').addEventListener('change', updateImage);



/************************************************************************
* Define Event Handlers
************************************************************************/

let tensorImage;
function updateImage() {
  let image = new Image();
  let fr = new FileReader();
  fr.onload = function() {
    image.src = fr.result;
  }
  fr.readAsDataURL($('#image-selector').files[0])
  image.onload = () => {
    tensorImage = tf.browser.fromPixels(image).div(255.0);
    console.log(tensorImage);
    let modelName = $('#select-model').value;
    if (modelName === 'mnist') {
      tensorImage = tf.reshape(tensorImage.resizeNearestNeighbor([16, 16]), [-1]);
      tensorImage = tensorImage.reshape([1, 784]);
    } else if (modelName === 'cifar') {
      tensorImage = tensorImage.resizeNearestNeighbor([32, 32]).reshape([1, 32, 32, 3]);
    } else if (modelName === 'gtsrb') {
      tensorImage = tensorImage.resizeNearestNeighbor([64, 64]).reshape([1, 64, 64, 3]);
    } else if (modelName === 'imagenet') {
      tensorImage = tensorImage.reshape([1, 224, 224, 3]);
    }
    drawImg(tensorImage, 'original');
  }
}

/**
 * Computes & displays prediction of the current original image
 */
async function predict() {
  if ($('#image-selector').value != '') {
    $('#predict-original').disabled = true;
    $('#predict-original').innerText = 'Loading...';
  
    let modelName = $('#select-model').value;
    if (modelName === 'mnist') {
      await loadMnistModel();
      _predict(mnistModel, tensorImage, MNIST_CLASSES);
    } else if (modelName === 'cifar') {
      await loadCifarModel();
      _predict(cifarModel, tensorImage, CIFAR_CLASSES);
    } else if (modelName === 'gtsrb') {
      await loadGtsrbModel();
      _predict(gtsrbModel, tensorImage, GTSRB_CLASSES);
    } else if (modelName === 'imagenet') {
      await loadImagenetModel();
      _predict(imagenetModel, tensorImage, IMAGENET_CLASSES);
    }
  
    $('#predict-original').innerText = 'Run Neural Network';
  
    function _predict(model, img, CLASS_NAMES) {
      // Generate prediction
      let pred = model.predict(img);
      let predLblIdx = pred.argMax(1).dataSync()[0];
      let predProb = pred.max().dataSync()[0];
  
      showPrediction(`Prediction: "${CLASS_NAMES[predLblIdx]}"<br/>Probability: ${(predProb * 100).toFixed(2)}%`);
      removeTopRightOverlay();
    }
  } else {
    alert('No image selected.')
  }

 }

/**
 * Generates adversarial example from the current original image
 */
let advPrediction, advStatus;
async function generateAdv() {
  $('#generate-adv').disabled = true;
  $('#generate-adv').innerText = 'Loading...';

  let attack;
  switch ($('#select-attack').value) {
    case 'fgsmTargeted': attack = fgsmTargeted; break;
    case 'bimTargeted': attack = bimTargeted; break;
    case 'jsmaOnePixel': attack = jsmaOnePixel; break;
    case 'jsma': attack = jsma; break;
    case 'cw': attack = cw; break;
  }

  let modelName = $('#select-model').value;
  let targetLblIdx = parseInt($('#select-target').value);

  if (modelName === 'mnist') {
    await loadMnistModel();
    //await loadingMnist;
    await _generateAdv(mnistModel, tensorImage, MNIST_CLASSES, MNIST_CONFIGS[attack.name]);
  } else if (modelName === 'cifar') {
    await loadCifarModel();
    //await loadingCifar;
    await _generateAdv(cifarModel, tensorImage, CIFAR_CLASSES, CIFAR_CONFIGS[attack.name]);
  } else if (modelName === 'gtsrb') {
    await loadGtsrbModel();
    //await loadingGtsrb;
    await _generateAdv(gtsrbModel, tensorImage, GTSRB_CLASSES, GTSRB_CONFIGS[attack.name]);
  } else if (modelName === 'imagenet') {
    await loadImagenetModel();
    //await loadedImagenetData;
    await _generateAdv(imagenetModel, tensorImage, IMAGENET_CLASSES, IMAGENET_CONFIGS[attack.name]);
  }

  $('#latency-msg').style.display = 'none';
  $('#generate-adv').innerText = 'Generate';
  $('#predict-adv').innerText = 'Run Neural Network';
  $('#predict-adv').disabled = false;

  async function _generateAdv(model, img, CLASS_NAMES, CONFIG) {
    let classCount = Object.keys(CLASS_NAMES).length;
    // Generate adversarial example
    let targetLbl = tf.oneHot(targetLblIdx, classCount).reshape([1, classCount]);
    let aimg = tf.tidy(() => attack(model, img, 0, targetLbl, CONFIG));

    // Display adversarial example
    $('#difference').style.display = 'block';
    await drawImg(aimg, 'adversarial');

    // Compute & store adversarial prediction
    let pred = model.predict(aimg);
    let predLblIdx = pred.argMax(1).dataSync()[0];
    let predProb = pred.max().dataSync()[0];
    advPrediction = `Prediction: "${CLASS_NAMES[predLblIdx]}"<br/>Probability: ${(predProb * 100).toFixed(2)}%`;

    // Also compute and draw the adversarial noise (hidden until the user clicks on it)
    let noise = tf.sub(aimg, img).add(0.5).clipByValue(0, 1);  // [Szegedy 14] Intriguing properties of neural networks
    drawImg(noise, 'adversarial-noise');
  }
}

/**
 * Displays prediction for the current adversarial image
 * (This function just renders the status we've already computed in generateAdv())
 */
function predictAdv() {
  $('#predict-adv').disabled = true;
  showAdvPrediction(advPrediction);
}

/**
 * Show adversarial noise when the user clicks on the "view noise" link
 */
async function viewNoise() {
  $('#difference').style.display = 'none';
  $('#difference-noise').style.display = 'block';
  $('#adversarial').style.display = 'none';
  $('#adversarial-noise').style.display = 'block';
}

/**
 * Show adversarial image when the user clicks on the "view image" link
 */
async function viewImage() {
  $('#difference').style.display = 'block';
  $('#difference-noise').style.display = 'none';
  $('#adversarial').style.display = 'block';
  $('#adversarial-noise').style.display = 'none';
}

/**
 * Reset entire dashboard UI when a new image is selected
 */
function resetOnNewImage() {
  $('#original').getContext('2d').clearRect(0, 0, 224, 224);
  $('#image-selector').value = '';
  $('#predict-original').disabled = false;
  $('#predict-original').innerText = 'Run Neural Network';
  $('#prediction').style.display = 'none';
  resetAttack();
  resetAvailableAttacks();
}

/**
 * Reset attack UI when a new target label, attack, or image is selected
 */
async function resetAttack() {
  $('#generate-adv').disabled = false;
  $('#predict-adv').disabled = true;
  $('#predict-adv').innerText = 'Click "Generate" First';
  $('#difference').style.display = 'none';
  $('#difference-noise').style.display = 'none';
  $('#prediction-adv').style.display = 'none';
  await drawImg(tf.ones([1, 224, 224, 1]), 'adversarial');
  await drawImg(tf.ones([1, 224, 224, 1]), 'adversarial-noise');
  $('#adversarial').style.display = 'block';
  $('#adversarial-noise').style.display = 'none';

  if ($('#select-model').value === 'gtsrb' || $('#select-model').value === 'imagenet') {
    $('#latency-msg').style.display = 'block';
  } else {
    $('#latency-msg').style.display = 'none';
  }
}

/**
 * Reset available attacks and target labels when a new image is selected
 */
function resetAvailableAttacks() {
  const MNIST_TARGETS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const CIFAR_TARGETS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const GTSRB_TARGETS = [8, 0, 14, 17];
  const IMAGENET_TARGETS = [934, 413, 151];

  let modelName = $('#select-model').value;
  if (modelName === 'mnist') {
    _resetAvailableAttacks(true, MNIST_TARGETS, MNIST_CLASSES);
  } else if (modelName === 'cifar') {
    _resetAvailableAttacks(true, CIFAR_TARGETS, CIFAR_CLASSES);
   }
  else if (modelName === 'gtsrb') {
    _resetAvailableAttacks(false, GTSRB_TARGETS, GTSRB_CLASSES);
  }
  else if (modelName === 'imagenet') {
    _resetAvailableAttacks(false, IMAGENET_TARGETS, IMAGENET_CLASSES);
  }

  function _resetAvailableAttacks(jsma, TARGETS, CLASS_NAMES) {
    let modelName = $('#select-model').value;
    let selectAttack = $('#select-attack');
    let selectTarget = $('#select-target');

    // Add or remove JSMA as an option
    if (jsma === true) {
      selectAttack.querySelector('option[value=jsma]').disabled = false;
    } else {
      selectAttack.querySelector('option[value=jsma]').disabled = true;
      if (selectAttack.value === 'jsma') { selectAttack.value = 'fgsmTargeted'; }
    }

    // Filter available target classes in dropdown
    if (selectTarget.getAttribute('data-model') === modelName) {

    } else {
      // Rebuild options from scratch (b/c the user chose a new model)
      selectTarget.innerHTML = '';
      TARGETS.forEach(i => {
        let option = new Option(CLASS_NAMES[i], i);
        selectTarget.appendChild(option);
      });
      selectTarget.setAttribute('data-model', modelName);
    }
  }
}

/**
 * Removes the overlay on the left half of the dashboard when the user selects a model
 */
function removeLeftOverlay() {
  $('#adversarial-image-overlay').style.display = 'block';
  $('#adversarial-canvas-overlay').style.display = 'block';
  $('#adversarial-prediction-overlay').style.display = 'block';
  $('#original-image-overlay').style.display = 'none';
  $('#original-canvas-overlay').style.display = 'none';
  $('#original-prediction-overlay').style.display = 'none';
}

/**
 * Removes the overlay on the top right of the dashboard when the user makes their first prediction
 */
function removeTopRightOverlay() {
  $('#adversarial-image-overlay').style.display = 'none';
  $('#adversarial-canvas-overlay').style.display = 'none';
}

/**
 * Removes the overlay on the bottom right of the dashboard when the user generates an adversarial example
 */
function removeBottomRightOverlay() {
  $('#adversarial-prediction-overlay').style.display = 'none';
}

/**
 * Check the user's device and display appropriate warning messages
 */
function showBanners() {
  if (!supports32BitWebGL()) { $('#mobile-banner').style.display = 'block'; }
  else if (!isDesktopChrome()) { $('#chrome-banner').style.display = 'block'; }
}

/**
 * Returns if it looks like the user is on desktop Google Chrome
 * https://stackoverflow.com/a/13348618/908744
 */
function isDesktopChrome() {
  var isChromium = window.chrome;
  var winNav = window.navigator;
  var vendorName = winNav.vendor;
  var isOpera = typeof window.opr !== "undefined";
  var isIEedge = winNav.userAgent.indexOf("Edge") > -1;
  var isIOSChrome = winNav.userAgent.match("CriOS");

  if (isIOSChrome) {
    return false;
  } else if (
    isChromium !== null &&
    typeof isChromium !== "undefined" &&
    vendorName === "Google Inc." &&
    isOpera === false &&
    isIEedge === false
  ) {
    return true;
  } else {
    return false;
  }
}

/**
 * Returns if the current device supports WebGL 32-bit
 * https://www.tensorflow.org/js/guide/platform_environment#precision
 */
function supports32BitWebGL() {
  return tf.ENV.getBool('WEBGL_RENDER_FLOAT32_CAPABLE') && tf.ENV.getBool('WEBGL_RENDER_FLOAT32_ENABLED');
}

/************************************************************************
* Visualize Images
************************************************************************/

function showPrediction(msg, status) {
  $('#prediction').innerHTML = msg;
  $('#prediction').style.display = 'block';
}

function showAdvPrediction(msg) {
  $('#prediction-adv').innerHTML = msg;
  $('#prediction-adv').style.display = 'block';
}

let cifarIdx = 0;
async function showCifar() {
  await loadingCifar;
  await drawImg(cifarDataset[cifarIdx].xs, 'original');
}
async function showNextCifar() {
  cifarIdx = (cifarIdx + 1) % cifarDataset.length;
  await showCifar();
}

let gtsrbIdx = 0;
async function showGtsrb() {
  await loadingGtsrb;
  await drawImg(gtsrbDataset[gtsrbIdx].xs, 'original');
}
async function showNextGtsrb() {
  gtsrbIdx = (gtsrbIdx + 1) % gtsrbDataset.length;
  await showGtsrb();
}

let imagenetIdx = 0;
async function showImagenet() {
  await loadingImagenetX;
  await drawImg(imagenetX[imagenetIdx], 'original');
}
async function showNextImagenet() {
  imagenetIdx = (imagenetIdx + 1) % imagenetX.length;
  await showImagenet();
}

async function drawImg(img, element) {
  // Draw image
  let canvas = document.getElementById(element);
  if (img.shape[0] === 1) { img = img.squeeze(0); }
  if (img.shape[0] === 784) {
    let resizedImg = tf.image.resizeNearestNeighbor(img.reshape([28, 28, 1]), [224, 224]);
    await tf.browser.toPixels(resizedImg, canvas);
  } else {
    let resizedImg = tf.image.resizeNearestNeighbor(img, [224, 224]);
    await tf.browser.toPixels(resizedImg, canvas);
  }
}
