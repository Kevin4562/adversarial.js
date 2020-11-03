/************************************************************************
* Load Dataset
************************************************************************/

let xUrl = 'https://storage.googleapis.com/download/storage/v1/b/kennysong-mnist/o/cifar10_sample_x_1.json?alt=media';
let yUrl = 'https://storage.googleapis.com/download/storage/v1/b/kennysong-mnist/o/cifar10_sample_y_1.json?alt=media';

// Load data in form [{xs: x0_tensor, ys: y0_tensor}, {xs: x1_tensor, ys: y1_tensor}, ...]
let x, y, dataset;
let loadingX = fetch(xUrl).then(res => res.json()).then(arr => x = tf.data.array(arr).batch(1));
let loadingY = fetch(yUrl).then(res => res.json()).then(arr => y = tf.data.array(arr).batch(1));
let loadingData = Promise.all([loadingX, loadingY]).then(() => tf.data.zip([x, y]).toArray()).then(ds => dataset = ds.map(e => { return {xs: e[0], ys: e[1]}}));

/************************************************************************
* Load Model
************************************************************************/

let model;
let loadingModel = tf.loadLayersModel('https://storage.googleapis.com/download/storage/v1/b/kennysong-mnist/o/cifar10_cnn_2.json?alt=media')
  .then(m => model = m);

let allLoaded = Promise.all([loadingData, loadingModel]);

/************************************************************************
* Visualize Attacks
************************************************************************/

const CONFIGS = {
  'fgsm': {ε: 0.05},  // 0.1 L_inf perturbation is too visible in color
  'jsmaOnePixel': {ε: 75},  // JSMA one-pixel on CIFAR-10 requires more ~3x pixels than MNIST
  'jsma': {ε: 75},  // JSMA on CIFAR-10 also requires more ~3x pixels than MNIST
  'cw': {c: 1, λ: 0.05}  // Tried to minimize distortion, but not sure it worked
};

const CLASS_NAMES = ['Plane', 'Car', 'Bird', 'Car', 'Deer', 'Dog', 'Frog', 'Horse', 'Ship', 'Truck'];

async function drawImg(img, element, attackName, msg, success) {
  let canvas = document.getElementById(attackName).getElementsByClassName(element)[0];
  let resizedImg = tf.image.resizeNearestNeighbor(img.reshape([32, 32, 3]), [64, 64]);
  await tf.browser.toPixels(resizedImg, canvas);

  if (msg !== undefined) {
    canvas.nextSibling.innerHTML = msg;
  }
  if (success === true) {
    canvas.style.borderColor = 'lime';
    canvas.style.borderWidth = '2px';
  }
}

export async function runUntargeted(attack) {
  await allLoaded;
  let successes = 0;

  for (let i = 0; i < 10; i++) {  // For each row
    let img = dataset[i].xs;
    let lbl = dataset[i].ys;

    let p = model.predict(img).dataSync()[i];
    await drawImg(img, i.toString(), attack.name, `Class: ${CLASS_NAMES[i]}<br/>Prob: ${p.toFixed(3)}`);

    let aimg = tf.tidy(() => attack(model, img, lbl, CONFIGS[attack.name]));

    p = model.predict(aimg).max(1).dataSync()[0];
    let albl = model.predict(aimg).argMax(1).dataSync()[0];
    let oldlbl = lbl.argMax(1).dataSync()[0];
    if (albl !== oldlbl) {
      successes++;
      await drawImg(aimg, `${i}a`, attack.name, `Class: ${CLASS_NAMES[albl]}<br/>Prob: ${p.toFixed(3)}`, true);
    }
    await drawImg(aimg, `${i}a`, attack.name, `Class: ${CLASS_NAMES[albl]}<br/>Prob: ${p.toFixed(3)}`);
  }

  document.getElementById(`${attack.name}-success-rate`).innerText = `Success rate: ${(successes / 10).toFixed(1)}`;
}

export async function runTargeted(attack) {
  await allLoaded;
  let successes = 0;

  for (let i = 0; i < 10; i++) {  // For each row
    let img = dataset[i].xs;
    let lbl = dataset[i].ys;

    let p = model.predict(img).dataSync()[i];
    await drawImg(img, i.toString(), attack.name, `Class: ${CLASS_NAMES[i]}<br/>Prob: ${p.toFixed(3)}`);

    for (let j = 0; j < 10; j++) {  // For each target label
      if (j === lbl.argMax(1).dataSync()[0]) {
        await drawImg(tf.zerosLike(img), `${i}${j}`, attack.name);
        continue;
      }

      let targetLbl = tf.oneHot(j, 10).reshape([1, 10]);
      let aimg = tf.tidy(() => attack(model, img, lbl, targetLbl, CONFIGS[attack.name]));

      p = model.predict(aimg).dataSync()[j];
      let predLbl = model.predict(aimg).argMax(1).dataSync()[0];
      if (predLbl === j) {
        successes++;
        await drawImg(aimg, `${i}${j}`, attack.name, `Class: ${CLASS_NAMES[j]}<br/>Prob: ${p.toFixed(3)}`, true);
      } else {
        await drawImg(aimg, `${i}${j}`, attack.name, `Class: ${CLASS_NAMES[j]}<br/>Prob: ${p.toFixed(3)}`);
      }
    }
  }

  document.getElementById(`${attack.name}-success-rate`).innerText = `Success rate: ${(successes / 90).toFixed(2)}`;
}