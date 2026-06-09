//! VoxTranslate server binary — see [`voxtranslate_server`] for the relay logic.

#[tokio::main]
async fn main() {
    voxtranslate_server::serve().await;
}
