use std::net::SocketAddr;

use acl_core::RuntimeConfig;
use acl_server::AclServer;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("acl=info".parse()?))
        .init();

    let addr: SocketAddr = "0.0.0.0:50051".parse()?;
    let config = RuntimeConfig::default();

    println!("╔══════════════════════════════════════════════╗");
    println!("║   Agent Collaboration Layer (ACL) v0.1.0    ║");
    println!("║   Non-Linguistic Agent Communication        ║");
    println!("║   & Orchestration Runtime                   ║");
    println!("╠══════════════════════════════════════════════╣");
    println!("║   gRPC server listening on {}    ║", addr);
    println!("╚══════════════════════════════════════════════╝");

    let server = AclServer::new(addr, config);
    server.serve().await?;

    Ok(())
}
