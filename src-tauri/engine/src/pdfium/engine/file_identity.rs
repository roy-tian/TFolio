//! Whether two paths name one file: by the file's identity where both can be
//! asked — symlinks, `..`, case-insensitive names and hard links all land on
//! one answer — else by the path as the filesystem resolves it.

use std::{
    cell::OnceCell,
    fs,
    path::{Path, PathBuf},
};

/// One side of a comparison, kept to be compared against many: the identity
/// is read once, the resolved spelling only if some comparison needs it.
pub struct FileKey {
    path: PathBuf,
    identity: Option<Identity>,
    resolved: OnceCell<PathBuf>,
}

impl FileKey {
    pub fn of(path: &Path) -> Self {
        Self {
            path: path.to_path_buf(),
            identity: identity(path),
            resolved: OnceCell::new(),
        }
    }

    pub fn names_same_file(&self, other: &FileKey) -> bool {
        match (&self.identity, &other.identity) {
            (Some(left), Some(right)) => left == right,
            _ => self.resolved() == other.resolved(),
        }
    }

    fn resolved(&self) -> &Path {
        self.resolved.get_or_init(|| resolved(&self.path))
    }
}

pub fn same_file(left: &Path, right: &Path) -> bool {
    FileKey::of(left).names_same_file(&FileKey::of(right))
}

/// A path as the filesystem names it. A fresh destination resolves through its
/// parent; the unresolvable stay literal, erring towards "different".
fn resolved(path: &Path) -> PathBuf {
    if let Ok(canonical) = path.canonicalize() {
        return canonical;
    }

    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => match parent.canonicalize() {
            Ok(parent) => parent.join(name),
            Err(_) => path.to_path_buf(),
        },
        _ => path.to_path_buf(),
    }
}

// Read from metadata, never an open: opening a FIFO would wait for a writer.
#[cfg(unix)]
type Identity = (u64, u64);

#[cfg(unix)]
fn identity(path: &Path) -> Option<Identity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path).ok()?;

    metadata.is_file().then(|| (metadata.dev(), metadata.ino()))
}

// Windows keeps the index behind a handle, which must stay open while two are
// compared: an index is only stable while its file is held. The index alone is
// not unique everywhere — ReFS truncates its 128-bit ids to it, and some network
// and virtual drives give every file one index — so size and modification time,
// which every name of one file shares, must match too.
#[cfg(windows)]
type Identity = (same_file::Handle, u64, Option<std::time::SystemTime>);

#[cfg(windows)]
fn identity(path: &Path) -> Option<Identity> {
    // A regular file only: a device or pipe name would answer the open itself.
    let metadata = fs::metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())?;
    let handle = same_file::Handle::from_path(path).ok()?;

    Some((handle, metadata.len(), metadata.modified().ok()))
}

#[cfg(not(any(unix, windows)))]
type Identity = ();

#[cfg(not(any(unix, windows)))]
fn identity(_path: &Path) -> Option<Identity> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "tfolio-identity-{}-{}",
            std::process::id(),
            getrandom::u64().unwrap()
        ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn spellings_of_one_file_name_it() {
        let directory = scratch();
        let file = directory.join("a.pdf");
        fs::write(&file, b"%PDF").unwrap();
        fs::create_dir(directory.join("sub")).unwrap();

        let doubled = PathBuf::from(format!("{}//a.pdf", directory.display()));
        let parent = directory.join("sub").join("..").join("a.pdf");

        assert!(same_file(&file, &doubled));
        assert!(same_file(&file, &parent));

        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn links_name_the_file_they_reach() {
        let directory = scratch();
        let file = directory.join("a.pdf");
        fs::write(&file, b"%PDF").unwrap();
        std::os::unix::fs::symlink(&file, directory.join("soft.pdf")).unwrap();
        fs::hard_link(&file, directory.join("hard.pdf")).unwrap();

        assert!(same_file(&file, &directory.join("soft.pdf")));
        assert!(same_file(&file, &directory.join("hard.pdf")));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn different_files_and_fresh_destinations_differ() {
        let directory = scratch();
        let file = directory.join("a.pdf");
        fs::write(&file, b"%PDF").unwrap();
        fs::write(directory.join("b.pdf"), b"%PDF").unwrap();

        assert!(!same_file(&file, &directory.join("b.pdf")));
        assert!(!same_file(&file, &directory.join("fresh.pdf")));
        assert!(
            same_file(&directory.join("gone.pdf"), &directory.join("gone.pdf")),
            "a missing file still matches its own spelling"
        );

        fs::remove_dir_all(directory).unwrap();
    }
}
