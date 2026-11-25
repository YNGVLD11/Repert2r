use ort::ep::{DirectML, CPU};
use ort::session::Session;
use ort::value::Tensor;
use rustfft::{num_complex::Complex, FftPlanner};
use std::f32::consts::PI;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const N_FFT: usize = 6144;
const HOP: usize = 1024;
const DIM_F: usize = 3072;
const DIM_T: usize = 256;
const CHUNK_SAMPLES: usize = (DIM_T - 1) * HOP;

pub struct SeparatedStems {
    pub sample_count: usize,
    pub vocals: Vec<f32>,
    pub instrumental: Vec<f32>,
}

pub struct StemState(pub Mutex<Option<SeparatedStems>>);

fn resolve_model_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(res_dir) = app.path().resource_dir() {
        let p1 = res_dir.join("resources").join("mdx_inst_hq3.onnx");
        if p1.exists() {
            return Ok(p1);
        }
        let p2 = res_dir.join("mdx_inst_hq3.onnx");
        if p2.exists() {
            return Ok(p2);
        }
    }
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("mdx_inst_hq3.onnx");
    if dev_path.exists() {
        return Ok(dev_path);
    }
    Err("Модель mdx_inst_hq3.onnx не найдена".to_string())
}

fn hann_window(len: usize) -> Vec<f32> {
    (0..len)
        .map(|i| 0.5 * (1.0 - (2.0 * PI * i as f32 / len as f32).cos()))
        .collect()
}

fn stft_channel(
    signal: &[f32],
    window: &[f32],
    fft: &dyn rustfft::Fft<f32>,
    real_out: &mut [f32],
    imag_out: &mut [f32],
) {
    let half = N_FFT / 2;
    let mut buf = vec![Complex::new(0.0f32, 0.0f32); N_FFT];

    for t in 0..DIM_T {
        let center = t * HOP;
        for i in 0..N_FFT {
            let idx = center as isize + i as isize - half as isize;
            let sample = if idx >= 0 && (idx as usize) < signal.len() {
                signal[idx as usize]
            } else {
                0.0
            };
            buf[i] = Complex::new(sample * window[i], 0.0);
        }
        fft.process(&mut buf);
        for f in 0..DIM_F {
            let out_idx = f * DIM_T + t;
            real_out[out_idx] = buf[f].re;
            imag_out[out_idx] = buf[f].im;
        }
    }
}

fn istft_channel(
    real_in: &[f32],
    imag_in: &[f32],
    window: &[f32],
    ifft: &dyn rustfft::Fft<f32>,
    out_len: usize,
) -> Vec<f32> {
    let half = N_FFT / 2;
    let inv_n = 1.0 / N_FFT as f32;
    let mut out = vec![0.0f32; out_len];
    let mut norm = vec![0.0f32; out_len];
    let mut buf = vec![Complex::new(0.0f32, 0.0f32); N_FFT];

    for t in 0..DIM_T {
        buf[0] = Complex::new(real_in[t], imag_in[t]);
        for f in 1..DIM_F {
            let idx = f * DIM_T + t;
            let re = real_in[idx];
            let im = imag_in[idx];
            buf[f] = Complex::new(re, im);
            buf[N_FFT - f] = Complex::new(re, -im);
        }
        buf[DIM_F] = Complex::new(0.0, 0.0);

        ifft.process(&mut buf);

        let center = t * HOP;
        for i in 0..N_FFT {
            let idx = center as isize + i as isize - half as isize;
            if idx >= 0 && (idx as usize) < out_len {
                let u = idx as usize;
                let w = window[i];
                out[u] += buf[i].re * inv_n * w;
                norm[u] += w * w;
            }
        }
    }

    for i in 0..out_len {
        if norm[i] > 1e-8 {
            out[i] /= norm[i];
        }
    }
    out
}

pub fn separate_mdx(
    app: &AppHandle,
    left: &[f32],
    right: &[f32],
) -> Result<(Vec<f32>, Vec<f32>), String> {
    let total = left.len().min(right.len());
    if total == 0 {
        return Err("Пустой аудиофайл".to_string());
    }

    let model_path = resolve_model_path(app)?;
    let env = ort::init().build().map_err(|e| e.to_string())?;
    let mut session = Session::builder(&env)
        .map_err(|e| e.to_string())?
        .with_execution_providers([DirectML::default().build(), CPU::default().build()])
        .map_err(|e| e.to_string())?
        .commit_from_file(&model_path)
        .map_err(|e| format!("Не удалось загрузить модель: {e}"))?;

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(N_FFT);
    let ifft = planner.plan_fft_inverse(N_FFT);
    let window = hann_window(N_FFT);

    let step = CHUNK_SAMPLES / 2;
    let fade_len = CHUNK_SAMPLES - step;
    let num_chunks = ((total.saturating_sub(1)) / step) + 1;

    let mut inst_l = vec![0.0f32; total];
    let mut inst_r = vec![0.0f32; total];
    let mut weight_sum = vec![0.0f32; total];

    let plane_size = DIM_F * DIM_T;
    let mut input_data = vec![0.0f32; 4 * plane_size];

    let _ = app.emit("separation-progress", 2u32);

    for chunk_idx in 0..num_chunks {
        let start = chunk_idx * step;
        let end = (start + CHUNK_SAMPLES).min(total);
        let len = end - start;

        let mut chunk_l = vec![0.0f32; CHUNK_SAMPLES];
        let mut chunk_r = vec![0.0f32; CHUNK_SAMPLES];
        chunk_l[..len].copy_from_slice(&left[start..end]);
        chunk_r[..len].copy_from_slice(&right[start..end]);

        let (p0, rest) = input_data.split_at_mut(plane_size);
        let (p1, rest) = rest.split_at_mut(plane_size);
        let (p2, p3) = rest.split_at_mut(plane_size);

        stft_channel(&chunk_l, &window, fft.as_ref(), p0, p1);
        stft_channel(&chunk_r, &window, fft.as_ref(), p2, p3);

        let tensor = Tensor::from_array(([1usize, 4, DIM_F, DIM_T], input_data.clone()))
            .map_err(|e| e.to_string())?;
        let outputs = session
            .run(ort::inputs!["input" => tensor])
            .map_err(|e| e.to_string())?;

        let (_, out_slice) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;

        let out_l = istft_channel(
            &out_slice[0..plane_size],
            &out_slice[plane_size..2 * plane_size],
            &window,
            ifft.as_ref(),
            CHUNK_SAMPLES,
        );
        let out_r = istft_channel(
            &out_slice[2 * plane_size..3 * plane_size],
            &out_slice[3 * plane_size..4 * plane_size],
            &window,
            ifft.as_ref(),
            CHUNK_SAMPLES,
        );

        for i in 0..len {
            let mut w = 1.0f32;
            if chunk_idx > 0 && i < fade_len {
                w *= i as f32 / fade_len as f32;
            }
            if chunk_idx + 1 < num_chunks && i >= step {
                w *= (CHUNK_SAMPLES - i) as f32 / fade_len as f32;
            }
            let pos = start + i;
            inst_l[pos] += out_l[i] * w;
            inst_r[pos] += out_r[i] * w;
            weight_sum[pos] += w;
        }

        let pct = 2 + (((chunk_idx + 1) * 96) / num_chunks) as u32;
        let _ = app.emit("separation-progress", pct.min(98));
    }

    for i in 0..total {
        if weight_sum[i] > 1e-6 {
            inst_l[i] /= weight_sum[i];
            inst_r[i] /= weight_sum[i];
        }
    }

    let mut vocals = Vec::with_capacity(total * 2);
    let mut instrumental = Vec::with_capacity(total * 2);

    for i in 0..total {
        vocals.push(left[i] - inst_l[i]);
    }
    for i in 0..total {
        vocals.push(right[i] - inst_r[i]);
    }
    instrumental.extend_from_slice(&inst_l);
    instrumental.extend_from_slice(&inst_r);

    let _ = app.emit("separation-progress", 100u32);
    Ok((vocals, instrumental))
}
