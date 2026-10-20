"""The window's Python side (lpc_view.app) without a window: the Api and the argv rules."""

from lpc_view.app import Api
from lpc_view.cli import normalise_argv
from lpc_view.server import make_server


def test_api_open_files(sample_las, sample_laz, tmp_path):
    srv = make_server([sample_las], port=0)
    try:
        answers = []
        api = Api(srv, choose=lambda: answers.pop(0))

        answers.append(None)  # dialog cancelled
        assert api.open_files() == {"cancelled": True, "added": [], "selected": []}
        assert api.file_count() == 1

        answers.append([str(sample_laz), str(sample_las)])  # one new, one already open
        r = api.open_files()
        assert r == {"cancelled": False, "added": [1], "selected": [0, 1]}
        assert api.file_count() == 2

        answers.append([str(tmp_path / "missing.laz")])
        r = api.open_files()
        assert r["added"] == [] and "not found" in r["error"]
    finally:
        srv.server_close()


def test_file_types_parse():
    from webview.util import parse_file_type

    from lpc_view.app import FILE_TYPES

    assert [parse_file_type(f) for f in FILE_TYPES] == [
        ("LAS and LAZ point clouds", "*.las;*.laz"),
        ("All files", "*.*"),
    ]


def test_normalise_argv(sample_las, tmp_path):
    assert normalise_argv([]) == []
    assert normalise_argv([], frozen=True) == ["app"]
    assert normalise_argv(["serve", "x"]) == ["serve", "x"]
    assert normalise_argv(["--version"]) == ["--version"]
    # "Open with" hands the exe paths and no command.
    assert normalise_argv([str(sample_las), str(tmp_path)]) == ["app", str(sample_las), str(tmp_path)]
    assert normalise_argv(["nonsense"]) == ["nonsense"]
