#!/usr/bin/env python3
"""
Generate a filled AO 442 Arrest Warrant PDF from warrant data passed via stdin as JSON.
Usage: python3 generate_warrant.py <output_path>
Reads warrant JSON from stdin.
"""
import sys
import json
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, create_string_object, BooleanObject
import os

def fill_warrant(data, output_path):
    template_path = os.path.join(os.path.dirname(__file__), 'data', 'warrant_template.pdf')
    reader = PdfReader(template_path)
    writer = PdfWriter()
    writer.clone_reader_document_root(reader)

    def s(val):
        return str(val) if val else ''

    warrant_type = s(data.get('type', 'arrest')).capitalize()
    subject      = s(data.get('subject', ''))
    county       = s(data.get('county', ''))
    issued_by    = s(data.get('issuedBy', ''))
    issued_at    = s(data.get('issuedAt', ''))
    description  = s(data.get('description', ''))
    warrant_num  = s(data.get('warrantNumber', ''))
    case_num     = s(data.get('linkedCaseNumber', warrant_num))
    dob          = s(data.get('subjectDob', ''))
    subject_desc = s(data.get('subjectDescription', ''))
    address      = s(data.get('address', ''))

    text_fields = {
        'DistLocation1':        'State of Texas',
        'DistState1':           'Texas',
        'CaseNumber':           case_num,
        'Defendant':            subject,
        'name of person to be arrested': subject,
        'Offense':              (description[:500] if description else f'{warrant_type} Warrant — {county} County, TX'),
        'Date':                 issued_at,
        'City and state':       f'{county} County, Texas',
        'Printed name and title': f'{issued_by}',
        'Name of defendantoffender': subject,
        'Date of birth':        dob,
        'Last known residence': address,
        'Scars tattoos other distinguishing marks': subject_desc,
    }
    checkbox_fields = {
        'Complaint': '/On',
    }

    writer.update_page_form_field_values(
        writer.pages[0],
        {k: v for k, v in text_fields.items() if k not in ['Name of defendantoffender', 'Date of birth',
                                                              'Last known residence',
                                                              'Scars tattoos other distinguishing marks']}
    )
    writer.update_page_form_field_values(
        writer.pages[1],
        {
            'Name of defendantoffender': subject,
            'Date of birth': dob,
            'Last known residence': address,
            'Scars tattoos other distinguishing marks': subject_desc,
        }
    )

    for page_num, page in enumerate(writer.pages):
        if '/Annots' not in page:
            continue
        for annot_ref in page['/Annots']:
            annot = annot_ref.get_object()
            if annot.get('/Subtype') != '/Widget':
                continue
            field_t = annot.get('/T')
            if field_t is None:
                continue
            field_id = str(field_t)
            if field_id in checkbox_fields:
                val = checkbox_fields[field_id]
                annot.update({
                    NameObject('/V'):  NameObject(val),
                    NameObject('/AS'): NameObject(val),
                })

    with open(output_path, 'wb') as f:
        writer.write(f)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: generate_warrant.py <output_path>', file=sys.stderr)
        sys.exit(1)
    output_path = sys.argv[1]
    data = json.loads(sys.stdin.read())
    fill_warrant(data, output_path)
    print('OK')
