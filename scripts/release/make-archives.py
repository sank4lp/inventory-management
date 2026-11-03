"""Portable .deb writer: runs on macOS, without a Linux packaging SDK."""
import argparse
import gzip
import io
import os
import pathlib
import tarfile


def archive(root, output, epoch):
    with open(output, 'wb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', mtime=epoch, compresslevel=6) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as tar:
                def normalise(info):
                    info.uid = info.gid = 0
                    info.uname = info.gname = 'root'
                    info.mtime = epoch
                    info.pax_headers = {}
                    return info
                for item in sorted(pathlib.Path(root).iterdir()):
                    tar.add(str(item), arcname='./' + item.name, filter=normalise)


def deb(root, control, output, epoch):
    # ar members are streamed: a complete offline compiler can be large.
    temp = pathlib.Path(output).parent
    data = temp / 'data.tar.gz'
    ctl = temp / 'control.tar.gz'
    archive(root, data, epoch)
    archive(control, ctl, epoch)
    with open(output, 'wb') as out:
        out.write(b'!<arch>\n')
        for name, source in [('debian-binary', None), ('control.tar.gz', ctl), ('data.tar.gz', data)]:
            size = 4 if source is None else source.stat().st_size
            header = f'{name + "/":<16}{epoch:<12}{0:<6}{0:<6}{"100644":<8}{size:<10}`\n'
            out.write(header.encode('ascii'))
            if source is None:
                out.write(b'2.0\n')
            else:
                with source.open('rb') as src:
                    while chunk := src.read(1024 * 1024):
                        out.write(chunk)
            if size % 2:
                out.write(b'\n')
    data.unlink()
    ctl.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['tar', 'deb'])
    parser.add_argument('root')
    parser.add_argument('output')
    parser.add_argument('--control')
    parser.add_argument('--epoch', type=int, default=0)
    args = parser.parse_args()
    if args.mode == 'tar':
        archive(args.root, args.output, args.epoch)
    else:
        deb(args.root, args.control, args.output, args.epoch)
