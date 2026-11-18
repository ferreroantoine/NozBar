fn main() {
    // Sans ceci, Cargo ne recompile pas les ressources de l'exécutable quand seules les icônes changent :
    // le programme installé garderait l'ancienne icône.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
