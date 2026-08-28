
use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit},
    Aes256Gcm,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub(crate) struct EncryptedPayload {
    pub nonce: String,
    pub tag: String,
    pub ciphertext: String,
}

pub(crate) fn derive_key(secret: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    let out = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    key
}

pub(crate) fn encrypt(plaintext: &[u8], secret: &str) -> Result<EncryptedPayload, String> {
    let key = derive_key(secret);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce = Aes256Gcm::generate_nonce(&mut rand::rngs::OsRng);
    let nonce_bytes: [u8; 12] = nonce.as_slice().try_into().map_err(|_| "nonce len")?;
    let ciphertext_with_tag = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| e.to_string())?;
    let (ct, tag) = if ciphertext_with_tag.len() >= 16 {
        let n = ciphertext_with_tag.len() - 16;
        (
            ciphertext_with_tag[..n].to_vec(),
            ciphertext_with_tag[n..].to_vec(),
        )
    } else {
        (ciphertext_with_tag.clone(), vec![])
    };
    Ok(EncryptedPayload {
        nonce: BASE64.encode(nonce_bytes),
        tag: BASE64.encode(&tag),
        ciphertext: BASE64.encode(&ct),
    })
}

pub(crate) fn decrypt(payload: &EncryptedPayload, secret: &str) -> Result<Vec<u8>, String> {
    let key = derive_key(secret);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let nonce_bytes = BASE64.decode(&payload.nonce).map_err(|e| e.to_string())?;
    let nonce = aes_gcm::Nonce::from_slice(
        nonce_bytes
            .get(..12)
            .ok_or("nonce too short")?,
    );
    let ct = BASE64.decode(&payload.ciphertext).map_err(|e| e.to_string())?;
    let tag = BASE64.decode(&payload.tag).map_err(|e| e.to_string())?;
    let mut combined = ct;
    combined.extend_from_slice(&tag);
    cipher.decrypt(nonce, combined.as_ref()).map_err(|e| e.to_string())
}
